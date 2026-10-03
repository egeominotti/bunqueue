import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, QueueEvents } from '../src/client';
import { QueueManager } from '../src/application/queueManager';
import { createTcpServer, type TcpServer } from '../src/infrastructure/server/tcp';

// Found by the skeptic review of the v2 job wait:
// - a broker outage longer than the connection's commandTimeout rejected a wait without a
//   TTL with "Command timeout" (its safety-net re-read timed out), although QueueEvents
//   reconnected and the job completed afterwards;
// - with the broker unreachable, a 5 s TTL without QueueEvents rejected only after ~30 s,
//   when the queued state read hit the command timeout.
// The tests use `embedded: false` explicitly: the test preload sets BUNQUEUE_EMBEDDED=1.

setDefaultTimeout(60_000);

let dir = '';
let manager: QueueManager | null = null;
let server: TcpServer | null = null;
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  server?.stop();
  manager?.shutdown();
  server = null;
  manager = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function outcome(wait: Promise<unknown>): Promise<{ value: unknown } | { error: string }> {
  return wait.then(
    (value) => ({ value }),
    (error: unknown) => ({ error: (error as Error).message })
  );
}

function startBroker(dataPath: string, port = 0): number {
  manager = new QueueManager({ dataPath });
  server = createTcpServer(manager, { hostname: '127.0.0.1', port });
  return server.server.port;
}

function stopBroker(): void {
  server?.stop();
  manager?.shutdown();
  server = null;
  manager = null;
}

test('a wait without a TTL survives an outage longer than the command timeout', async () => {
  dir = mkdtempSync(join(tmpdir(), 'wait-outage-'));
  const dataPath = join(dir, 'q.db');
  const port = startBroker(dataPath);
  const connection = { host: '127.0.0.1', port, poolSize: 1, commandTimeout: 1_000 };
  const queue = new Queue('outage', { embedded: false, connection, autoBatch: { enabled: false } });
  const events = new QueueEvents('outage', { embedded: false, connection });
  cleanups.push(
    () => queue.close(),
    () => events.close()
  );
  await events.waitUntilReady();
  const job = await queue.add('job', {}, { durable: true });
  const started = Date.now();
  const wait = outcome(job.waitUntilFinished(events));
  await Bun.sleep(300);

  // Down long enough for the first safety-net re-read (5 s, jittered) to fail.
  stopBroker();
  await Bun.sleep(8_000);
  startBroker(dataPath, port);
  await Bun.sleep(1_500);
  const pulled = await manager!.pull('outage');
  expect(String(pulled?.id)).toBe(job.id);
  await manager!.ack(pulled!.id, 'done');

  expect(await Promise.race([wait, Bun.sleep(20_000).then(() => 'pending')])).toEqual({
    value: 'done',
  });
  expect(Date.now() - started).toBeGreaterThan(9_000);
});

test('a TTL bounds a wait even while the broker is unreachable', async () => {
  dir = mkdtempSync(join(tmpdir(), 'wait-unreachable-'));
  const port = startBroker(join(dir, 'q.db'));
  const connection = { host: '127.0.0.1', port, poolSize: 1 };
  const queue = new Queue('unreachable', {
    embedded: false,
    connection,
    autoBatch: { enabled: false },
  });
  cleanups.push(() => queue.close());
  const job = await queue.add('job', {}, { durable: true });
  stopBroker();
  // The pool has seen the connection close: commands now queue until it reconnects.
  await Bun.sleep(500);

  const started = Date.now();
  const waits = [outcome(job.waitUntilFinished(null, 2_000))];

  expect(await Promise.race([Promise.all(waits), Bun.sleep(8_000).then(() => 'pending')])).toEqual([
    { error: 'waitUntilFinished timed out after 2000ms' },
  ]);
  expect(Date.now() - started).toBeLessThan(4_500);
});
