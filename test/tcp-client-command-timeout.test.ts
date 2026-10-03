import { afterEach, expect, test } from 'bun:test';
import type { Socket, TCPSocketListener } from 'bun';
import { pack, unpack } from 'msgpackr';
import { TcpClient } from '../src/client/tcp/client';
import { TcpConnectionPool } from '../src/client/tcpPool';
import { FrameParser } from '../src/infrastructure/server/protocol';

// `send(command, { timeout })` gives one command its own timeout, used by the job
// wait for WaitJob, which the broker holds on purpose: under the connection's
// `commandTimeout` a hold at or above it was reported as "Command timeout", and three
// of them forced a reconnect that failed every other in-flight command.

let server: TCPSocketListener<FrameParser> | null = null;
const clients: Array<{ close(): void }> = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  server?.stop(true);
  server = null;
});

/** Replies to `{ cmd: 'Hold', ms }` after `ms`, and to anything else at once. */
function startServer(): number {
  server = Bun.listen<FrameParser>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        socket.data = new FrameParser();
      },
      data(socket: Socket<FrameParser>, chunk) {
        for (const frame of socket.data.addData(chunk)) {
          const command = unpack(frame) as { cmd: string; reqId: string; ms?: number };
          const reply = () =>
            socket.write(
              FrameParser.frame(pack({ ok: true, reqId: command.reqId, data: { pong: true } }))
            );
          if (command.cmd === 'Hold') setTimeout(reply, command.ms ?? 0);
          else reply();
        }
      },
    },
  });
  return server.port;
}

function client(port: number, options: { maxInFlight?: number } = {}): TcpClient {
  const created = new TcpClient({
    host: '127.0.0.1',
    port,
    commandTimeout: 200,
    pingInterval: 0,
    maxInFlight: options.maxInFlight ?? 100,
  });
  clients.push(created);
  return created;
}

test('a command with its own timeout outlives the connection commandTimeout', async () => {
  const tcp = client(startServer());
  await tcp.connect();

  expect((await tcp.send({ cmd: 'Hold', ms: 500 }, { timeout: 2_000 })).ok).toBe(true);
  await expect(tcp.send({ cmd: 'Hold', ms: 500 })).rejects.toThrow('Command timeout');
});

test('the own timeout also applies once a queued command is sent', async () => {
  // One command in flight at a time: the second waits in the queue, then is sent.
  const tcp = client(startServer(), { maxInFlight: 1 });
  await tcp.connect();

  const first = tcp.send({ cmd: 'Hold', ms: 100 });
  const second = tcp.send({ cmd: 'Hold', ms: 500 }, { timeout: 2_000 });

  expect((await first).ok).toBe(true);
  expect((await second).ok).toBe(true);
});

test('only a command that overruns its own timeout counts toward a forced reconnect', async () => {
  const tcp = client(startServer());
  await tcp.connect();

  await Promise.all([1, 2, 3].map(() => tcp.send({ cmd: 'Hold', ms: 400 }, { timeout: 2_000 })));
  expect(tcp.getHealth().consecutiveCommandTimeouts).toBe(0);
  expect(tcp.isConnected()).toBe(true);

  await expect(tcp.send({ cmd: 'Hold', ms: 1_000 }, { timeout: 100 })).rejects.toThrow(
    'Command timeout'
  );
  expect(tcp.getHealth().consecutiveCommandTimeouts).toBe(1);
});

test('the pool forwards the per-command timeout', async () => {
  const pool = new TcpConnectionPool({
    host: '127.0.0.1',
    port: startServer(),
    poolSize: 1,
    commandTimeout: 200,
    pingInterval: 0,
  });
  clients.push(pool);
  await pool.connect();

  expect((await pool.send({ cmd: 'Hold', ms: 500 }, { timeout: 2_000 })).ok).toBe(true);
});
