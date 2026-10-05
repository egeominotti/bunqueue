/**
 * Repro (real worker threads, real broker): SandboxedWorker stop()/start() and the
 * idle watch against the shared TCP pool.
 *
 * Every stop() released the worker's shared-pool reference, idle stops included, and
 * start() never took one back:
 * - a second stop(), or a stop() after an idle stop, closed the pool under its other
 *   users (here a Queue, which shares a pool with the same connection key);
 * - as the pool's only user, start() after stop() pulled on a closed pool, and the
 *   `autoStart` watch polled a closed pool, so the pool never restarted.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Queue } from '../src/client';
import { SandboxedWorker } from '../src/client/sandboxed';
import {
  type CoreE2eHarness,
  MODES,
  closeHarness,
  startHarness,
  waitForState,
  waitUntil,
} from './docs-guide-support';

let harness: CoreE2eHarness | null = null;
let worker: SandboxedWorker | null = null;
const sharedQueues: Queue[] = [];

afterEach(async () => {
  await worker?.stop(true).catch(() => undefined);
  worker = null;
  for (const queue of sharedQueues.splice(0)) await queue.close();
  await closeHarness(harness);
  harness = null;
});

function processorPath(active: CoreE2eHarness): string {
  const path = join(active.dataDir, 'processor.ts');
  writeFileSync(path, 'export default async (job: { data: { n: number } }) => job.data.n * 2;\n');
  return path;
}

/**
 * A Queue and a connection that share one pool: Queue uses the shared pool only with
 * the default poolSize (4) and no token, and the harness Queue uses poolSize 1.
 */
function sharedPoolUsers(active: CoreE2eHarness): {
  queue: Queue;
  connection: { host: string; port: number; poolSize: number };
} {
  const connection = { ...active.connection(), poolSize: 4 };
  const queue = new Queue(active.unique('shared-pool'), {
    embedded: false,
    connection,
    autoBatch: { enabled: false },
  });
  sharedQueues.push(queue);
  return { queue, connection };
}

/** The harness connection with a pool of its own (a different pool key). */
function soleConnection(active: CoreE2eHarness): Record<string, unknown> {
  return active.mode === 'tcp' ? { connection: { ...active.connection(), poolSize: 2 } } : {};
}

for (const mode of MODES) {
  describe(`SandboxedWorker pool lifecycle [${mode}]`, () => {
    test('stop() then start() processes jobs again', async () => {
      harness = await startHarness('sandboxed-restart', mode);
      const queue = harness.queue<{ n: number }>('jobs');
      worker = new SandboxedWorker(queue.name, {
        processor: processorPath(harness),
        ...soleConnection(harness),
      });
      worker.on('error', () => undefined);

      await worker.start();
      const first = await queue.add('double', { n: 1 }, { durable: true });
      await waitForState(queue, first.id, 'completed', 10_000);
      await worker.stop();

      await worker.start();
      const second = await queue.add('double', { n: 2 }, { durable: true });
      await waitForState(queue, second.id, 'completed', 10_000);
      expect((await queue.getJob(second.id))?.returnvalue).toBe(4);
    }, 30_000);

    test('a start() whose processor fails to load rejects; once fixed, start() works', async () => {
      harness = await startHarness('sandboxed-failed-start', mode);
      const queue = harness.queue<{ n: number }>('jobs');
      const path = processorPath(harness);
      writeFileSync(path, "throw new Error('processor failed at import');\n");
      worker = new SandboxedWorker(queue.name, {
        processor: path,
        concurrency: 2,
        ...soleConnection(harness),
      });
      worker.on('error', () => undefined);

      await expect(worker.start()).rejects.toThrow('processor failed at import');
      expect(worker.isRunning()).toBe(false);
      expect(worker.getStats().total).toBe(0);

      processorPath(harness);
      await worker.start();
      const job = await queue.add('double', { n: 4 }, { durable: true });
      await waitForState(queue, job.id, 'completed', 10_000);
      expect((await queue.getJob(job.id))?.returnvalue).toBe(8);
    }, 30_000);

    test('autoStart restarts the pool when a job arrives after an idle stop', async () => {
      harness = await startHarness('sandboxed-autostart', mode);
      const queue = harness.queue<{ n: number }>('jobs');
      let closed = 0;
      let ready = 0;
      worker = new SandboxedWorker(queue.name, {
        processor: processorPath(harness),
        idleTimeout: 200,
        autoStart: true,
        autoStartPollMs: 50,
        ...soleConnection(harness),
      });
      worker.on('error', () => undefined);
      worker.on('closed', () => closed++);
      worker.on('ready', () => ready++);

      await worker.start();
      await waitUntil(() => closed === 1, 'the idle stop', 10_000);
      expect(worker.isRunning()).toBe(false);

      const job = await queue.add('double', { n: 5 }, { durable: true });
      await waitForState(queue, job.id, 'completed', 10_000);
      expect(ready).toBe(2);
      expect((await queue.getJob(job.id))?.returnvalue).toBe(10);
    }, 30_000);
  });
}

describe('SandboxedWorker shares its TCP pool safely [tcp]', () => {
  test('stop() twice leaves the shared pool usable for its other users', async () => {
    harness = await startHarness('sandboxed-double-stop', 'tcp');
    const { queue, connection } = sharedPoolUsers(harness);
    worker = new SandboxedWorker(queue.name, { processor: processorPath(harness), connection });
    worker.on('error', () => undefined);
    await worker.start();
    await worker.stop();
    await worker.stop();

    const job = await queue.add('after-stop', { n: 1 }, { durable: true });
    expect(await queue.getJobState(job.id)).toBe('waiting');
  }, 30_000);

  test('an idle stop followed by stop() releases the shared pool once', async () => {
    harness = await startHarness('sandboxed-idle-then-stop', 'tcp');
    const { queue, connection } = sharedPoolUsers(harness);
    let closed = 0;
    worker = new SandboxedWorker(queue.name, {
      processor: processorPath(harness),
      idleTimeout: 200,
      connection,
    });
    worker.on('error', () => undefined);
    worker.on('closed', () => closed++);
    await worker.start();
    await waitUntil(() => closed === 1, 'the idle stop', 10_000);
    await worker.stop();

    const job = await queue.add('after-idle-stop', { n: 1 }, { durable: true });
    expect(await queue.getJobState(job.id)).toBe('waiting');
    expect(closed).toBe(1);
  }, 30_000);
});
