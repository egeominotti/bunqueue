import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Socket, TCPSocketListener } from 'bun';
import { pack, unpack } from 'msgpackr';
import { Queue, TcpConnectionPool, Worker } from '../src/client';
import { QueueManager } from '../src/application/queueManager';
import { createTcpServer, type TcpServer } from '../src/infrastructure/server/tcp';
import { FrameParser } from '../src/infrastructure/server/protocol';

// Found by the skeptic review of the v3 job wait: WaitJob holds were capped at 32 per
// connection pool, on the wrong premise that a pool routes everything through one
// connection (a 4-connection pool splits commands evenly). With more than 32 waits
// without QueueEvents, the others learned of a completion only from scheduled reads:
// 100 request/response waits on a default pool resolved about 1 s after their job
// completed (HEAD: at once). The cap is now per connection, holds go to the connection
// with the fewest, and a hold never takes more than half of a connection's send window.
// `embedded: false` is explicit: the test preload sets BUNQUEUE_EMBEDDED=1.

setDefaultTimeout(60_000);

let dir = '';
let manager: QueueManager | null = null;
let server: TcpServer | null = null;
let mockServer: TCPSocketListener<FrameParser> | null = null;
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  server?.stop();
  manager?.shutdown();
  mockServer?.stop(true);
  server = null;
  manager = null;
  mockServer = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function startBroker(): { host: string; port: number } {
  dir = mkdtempSync(join(tmpdir(), 'wait-hold-routing-'));
  manager = new QueueManager({ dataPath: join(dir, 'q.db') });
  server = createTcpServer(manager, { hostname: '127.0.0.1', port: 0 });
  return { host: '127.0.0.1', port: server.server.port };
}

test('100 waits without QueueEvents on a 4-connection pool learn of completion at once', async () => {
  const connection = { ...startBroker(), poolSize: 4 };
  const queue = new Queue('routing', { embedded: false, connection });
  const worker = new Worker('routing', () => Bun.sleep(1_000).then(() => 'done'), {
    embedded: false,
    connection: { ...connection, poolSize: 2 },
    concurrency: 50,
  });
  cleanups.push(
    () => queue.close(),
    () => worker.close(true)
  );
  const completedAt = new Map<string, number>();
  worker.on('completed', (job) => completedAt.set(job.id, performance.now()));

  const resolved = await Promise.all(
    Array.from({ length: 100 }, async (_, i) => {
      const job = await queue.add('job', { i });
      expect(await job.waitUntilFinished(null, 30_000)).toBe('done');
      return { id: job.id, at: performance.now() };
    })
  );

  // The worker reports a completion slightly after the broker records it, so a wait
  // can resolve first: such a delay counts as 0.
  const delays = resolved
    .map(({ id, at }) => Math.max(0, at - (completedAt.get(id) ?? at)))
    .sort((a, b) => a - b);
  expect(completedAt.size).toBe(100);
  // v3: p90 about 1,020 ms (68 of the 100 waits had no hold); HEAD: about 0 ms.
  expect(delays[Math.floor(delays.length * 0.9)]).toBeLessThan(400);
});

test('holds take at most half of a connection send window', async () => {
  const connection = { ...startBroker(), poolSize: 1, maxInFlight: 4 };
  const queue = new Queue('window', { embedded: false, connection, autoBatch: { enabled: false } });
  cleanups.push(() => queue.close());
  const jobs = await queue.addBulk(
    Array.from({ length: 10 }, (_, i) => ({ name: 'job', data: { i } }))
  );
  // No worker: the jobs never finish, so every wait holds WaitJob as long as it may.
  const waits = jobs.map((job) => job.waitUntilFinished(null, 15_000).catch(() => undefined));
  await Bun.sleep(3_500);

  const started = performance.now();
  await queue.getJobCounts();
  expect(performance.now() - started).toBeLessThan(500);
  await Promise.all(waits);
});

test('the pool leases long-poll slots across its connections, within a per-connection limit', async () => {
  // A broker double that answers every command 300 ms later and counts them per socket.
  const perSocket = new Map<Socket<FrameParser>, number>();
  mockServer = Bun.listen<FrameParser>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        socket.data = new FrameParser();
      },
      data(socket: Socket<FrameParser>, chunk) {
        for (const frame of socket.data.addData(chunk)) {
          const { reqId } = unpack(frame) as { reqId: string };
          perSocket.set(socket, (perSocket.get(socket) ?? 0) + 1);
          setTimeout(() => socket.write(FrameParser.frame(pack({ ok: true, reqId }))), 300);
        }
      },
    },
  });
  const pool = new TcpConnectionPool({
    host: '127.0.0.1',
    port: mockServer.port,
    poolSize: 4,
    pingInterval: 0,
  });
  cleanups.push(() => pool.close());

  const leases = Array.from({ length: 8 }, () => pool.reserveLongPoll(2));
  expect(leases.every((lease) => lease !== null)).toBe(true);
  expect(pool.reserveLongPoll(2)).toBeNull();
  await Promise.all(leases.map((lease) => lease?.send({ cmd: 'WaitJob' }, { timeout: 5_000 })));
  expect([...perSocket.values()]).toEqual([2, 2, 2, 2]);

  // A released slot can be leased again.
  leases[0]?.release();
  expect(pool.reserveLongPoll(2)).not.toBeNull();
});

test('a pool leases at most half of a connection send window', () => {
  const pool = new TcpConnectionPool({ port: 1, poolSize: 1, maxInFlight: 6, pingInterval: 0 });
  cleanups.push(() => pool.close());

  const leases = Array.from({ length: 5 }, () => pool.reserveLongPoll(40));

  expect(leases.filter((lease) => lease !== null).length).toBe(3);
});
