import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, QueueEvents, Worker, shutdownManager } from '../src/client';
import type { QueueManager } from '../src/application/queueManager';
import { waitJobUntilFinished } from '../src/client/jobWait';
import { getSharedManager } from '../src/client/manager';

// Every embedded wait used to be its own subscriber of the shared manager, invoked for
// every event in the process, so N concurrent waits cost O(N) per event (found by the
// skeptic review of the first jobWait.ts: 20,000 waits ran 7.39s against 4.42s before).
// Waits now share one subscription per manager that dispatches by job id, created on
// first use, released when the last wait settles, and never carried over to a manager
// created after shutdownManager(). Waits on one QueueEvents share its listeners the same
// way, so they add no per-wait listener (and no MaxListenersExceededWarning).

setDefaultTimeout(20_000);

let dir = '';

afterEach(() => {
  shutdownManager();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function freshDataPath(): string {
  dir ||= mkdtempSync(join(tmpdir(), 'job-wait-dispatch-'));
  return join(dir, `${crypto.randomUUID()}.db`);
}

function subscribers(manager: QueueManager): number {
  return (manager as unknown as { eventsManager: { subscriberCount: number } }).eventsManager
    .subscriberCount;
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

test('concurrent embedded waits share one manager subscription', async () => {
  const dataPath = freshDataPath();
  const queue = new Queue<{ i: number }>('dispatch', { embedded: true, dataPath });
  const manager = getSharedManager(dataPath);
  const jobs = await queue.addBulk(range(200).map((i) => ({ name: 'job', data: { i } })));
  const baseline = subscribers(manager);

  const waits = jobs.map((job) => job.waitUntilFinished(null, 15_000));
  expect(subscribers(manager)).toBe(baseline + 1);

  const worker = new Worker<{ i: number }>('dispatch', (job) => job.data.i, {
    embedded: true,
    dataPath,
    concurrency: 20,
  });
  expect(await Promise.all(waits)).toEqual(range(200));
  await worker.close();
  await queue.close();
  expect(subscribers(manager)).toBe(baseline);
});

test('a manager created after shutdownManager() gets its own subscription', async () => {
  const first = new Queue('dispatch-restart', { embedded: true, dataPath: freshDataPath() });
  const stale = await first.add('job', {});
  const staleWait = stale.waitUntilFinished(null, 15_000).catch((error: Error) => error.message);
  await first.close();
  shutdownManager();
  expect(await staleWait).toBe('waitUntilFinished: the embedded engine was shut down');

  const dataPath = freshDataPath();
  const queue = new Queue('dispatch-restart', { embedded: true, dataPath });
  const manager = getSharedManager(dataPath);
  const job = await queue.add('job', {});
  const baseline = subscribers(manager);
  const wait = job.waitUntilFinished(null, 15_000);
  expect(subscribers(manager)).toBe(baseline + 1);

  const worker = new Worker('dispatch-restart', () => 'done', { embedded: true, dataPath });
  expect(await wait).toBe('done');
  await worker.close();
  await queue.close();
});

test('waits on one QueueEvents share its listeners', async () => {
  const dataPath = freshDataPath();
  const queue = new Queue<{ i: number }>('dispatch-events', { embedded: true, dataPath });
  const events = new QueueEvents('dispatch-events', { embedded: true, dataPath });
  const jobs = await queue.addBulk(range(50).map((i) => ({ name: 'job', data: { i } })));

  const waits = jobs.map((job) => job.waitUntilFinished(events));
  expect(events.listenerCount('completed')).toBe(1);
  expect(events.listenerCount('failed')).toBe(1);

  const worker = new Worker<{ i: number }>('dispatch-events', (job) => job.data.i, {
    embedded: true,
    dataPath,
    concurrency: 10,
  });
  expect(await Promise.all(waits)).toEqual(range(50));
  expect(events.listenerCount('completed')).toBe(0);
  expect(events.listenerCount('failed')).toBe(0);
  await worker.close();
  events.close();
  await queue.close();
});

test('waits on one QueueEvents share one readiness round trip', async () => {
  // A TCP QueueEvents answers waitUntilReady() with a Ping on its own connection, which
  // counts toward that connection's rate limit: N waits must not mean N pings.
  let readyCalls = 0;
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const events = {
    on(event: string, listener: (data: unknown) => void) {
      listeners.set(event, (listeners.get(event) ?? new Set()).add(listener));
    },
    off(event: string, listener: (data: unknown) => void) {
      listeners.get(event)?.delete(listener);
    },
    waitUntilReady() {
      readyCalls++;
      return Bun.sleep(20);
    },
  };
  const tcp = { send: () => Promise.resolve({ ok: true, state: 'waiting' }) };

  const waits = Array.from({ length: 20 }, (_, i) =>
    waitJobUntilFinished({ tcp }, `job-${i}`, events, 300).catch((error: Error) => error.message)
  );

  expect(new Set(await Promise.all(waits)).size).toBe(20);
  expect(readyCalls).toBe(1);
});
