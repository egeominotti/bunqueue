import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Socket, TCPSocketListener } from 'bun';
import { TcpClient } from '../src/client/tcp/client';
import { isTransientError, isTransientReply } from '../src/client/job-wait/types';

// The job wait retries a read that failed for a transient reason, recognized by its
// message. These tests tie each message to the code that produces it, so rewording the
// broker's rate-limit reply or the client's timeout/connection errors fails here
// instead of silently turning a retryable failure into a final one.

const root = join(import.meta.dir, '..');
let server: TCPSocketListener<undefined> | null = null;
let client: TcpClient | null = null;

afterEach(() => {
  client?.close();
  server?.stop(true);
  client = null;
  server = null;
});

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

/** A broker double that accepts frames and never answers; `drop` closes every socket. */
function silentServer() {
  const sockets = new Set<Socket<undefined>>();
  server = Bun.listen<undefined>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open: (socket) => void sockets.add(socket),
      data: () => undefined,
      close: (socket) => void sockets.delete(socket),
    },
  });
  return {
    port: server.port,
    drop: () => {
      for (const socket of sockets) socket.end();
    },
  };
}

test("the broker's rate-limit reply is retryable", () => {
  expect(source('src/infrastructure/server/tcp.ts')).toContain(
    "tcpErrorResponse('Rate limit exceeded', requestId)"
  );
  expect(isTransientReply({ ok: false, error: 'Rate limit exceeded' })).toBe(true);
  expect(isTransientError(new Error('Rate limit exceeded'))).toBe(true);
});

test("the client's command timeout is retryable", async () => {
  const { port } = silentServer();
  client = new TcpClient({ host: '127.0.0.1', port, commandTimeout: 100, pingInterval: 0 });
  await client.connect();

  const error = await client.send({ cmd: 'Ping' }).catch((caught: unknown) => caught);

  expect(isTransientError(error)).toBe(true);
});

test("the client's lost connection is retryable", async () => {
  const broker = silentServer();
  client = new TcpClient({ host: '127.0.0.1', port: broker.port, pingInterval: 0 });
  await client.connect();
  const pending = client.send({ cmd: 'Ping' }).catch((caught: unknown) => caught);
  await Bun.sleep(50);

  broker.drop();

  expect(isTransientError(await pending)).toBe(true);
});

test("the client's not-connected error is retryable", () => {
  // Only the authentication handshake can meet it; its text is what the wait matches.
  expect(source('src/client/tcp/runtime/commands.ts')).toContain(
    "Promise.reject(new Error('Not connected'))"
  );
  expect(isTransientError(new Error('Not connected'))).toBe(true);
});

test('a final failure is not retryable', () => {
  expect(isTransientError(new Error('Not authenticated'))).toBe(false);
  expect(isTransientError(new Error('Connection pool is closed'))).toBe(false);
  expect(isTransientReply({ ok: false, error: 'Job not found' })).toBe(false);
});
