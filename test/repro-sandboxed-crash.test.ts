/**
 * Repro (real worker threads, real broker): crashed SandboxedWorker threads.
 *
 * handleCrash never marked a crashed thread as dead. Once autoRestart was off or
 * maxRestarts was used up, the pull loop kept dispatching jobs to the dead thread,
 * where they hung for good with `timeout: 0`. A thread that exited (process.exit in
 * the processor) raised only Bun's `close` event, which nothing handled: its job hung
 * and the thread kept receiving jobs even with restarts left.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SandboxedWorker } from '../src/client/sandboxed';
import {
  type CoreE2eHarness,
  MODES,
  closeHarness,
  startHarness,
  waitForState,
  waitUntil,
} from './docs-guide-support';

type ReportedError = Error & { context?: string };

let harness: CoreE2eHarness | null = null;
let worker: SandboxedWorker | null = null;

afterEach(async () => {
  await worker?.stop(true).catch(() => undefined);
  worker = null;
  await closeHarness(harness);
  harness = null;
});

/**
 * A processor that, by job data, exits its thread, crashes it with an uncaught
 * error, or returns `n * 2`.
 */
function crashingProcessor(active: CoreE2eHarness): string {
  const path = join(active.dataDir, 'crashing-processor.ts');
  writeFileSync(
    path,
    `export default async (job: { data: { mode?: string; n?: number } }) => {
  if (job.data.mode === 'exit') process.exit(3);
  if (job.data.mode === 'throw') {
    await new Promise(() => setTimeout(() => { throw new Error('thread crash'); }, 0));
  }
  return (job.data.n ?? 0) * 2;
};\n`
  );
  return path;
}

function startWorker(
  active: CoreE2eHarness,
  queue: string,
  options: { autoRestart?: boolean; maxRestarts?: number; concurrency?: number }
): { worker: SandboxedWorker; errors: ReportedError[]; closed: () => number } {
  let closed = 0;
  const errors: ReportedError[] = [];
  const created = new SandboxedWorker(queue, {
    processor: crashingProcessor(active),
    timeout: 0, // A job on a dead thread would hang for good.
    ...options,
    ...(active.mode === 'tcp' ? { connection: active.connection() } : {}),
  });
  created.on('error', (error) => errors.push(error));
  created.on('closed', () => closed++);
  worker = created;
  return { worker: created, errors, closed: () => closed };
}

const contexts = (errors: ReportedError[]) => errors.map((error) => error.context);

for (const mode of MODES) {
  describe(`SandboxedWorker crashed threads [${mode}]`, () => {
    test('a thread that exits fails its job at once and is restarted', async () => {
      harness = await startHarness('sandboxed-exit', mode);
      const queue = harness.queue<{ mode?: string; n?: number }>('jobs');
      const { worker: created } = startWorker(harness, queue.name, {});
      await created.start();

      const exiting = await queue.add('exit', { mode: 'exit' }, { attempts: 1, durable: true });
      await waitForState(queue, exiting.id, 'failed', 5_000);
      expect((await queue.getJob(exiting.id))?.failedReason).toContain('Worker crashed');

      const next = await queue.add('double', { n: 4 }, { durable: true });
      await waitForState(queue, next.id, 'completed', 5_000);
      expect((await queue.getJob(next.id))?.returnvalue).toBe(8);
    }, 30_000);

    test('with autoRestart off, the dead thread gets no job and the worker stops', async () => {
      harness = await startHarness('sandboxed-no-restart', mode);
      const queue = harness.queue<{ mode?: string; n?: number }>('jobs');
      const started = startWorker(harness, queue.name, { autoRestart: false });
      const { worker: created, errors, closed } = started;
      await created.start();

      const crashing = await queue.add('throw', { mode: 'throw' }, { attempts: 1, durable: true });
      await waitForState(queue, crashing.id, 'failed', 5_000);
      await waitUntil(() => !created.isRunning(), 'the worker to stop', 5_000);

      const after = await queue.add('double', { n: 1 }, { durable: true });
      await Bun.sleep(1_500);
      expect(await queue.getJobState(after.id)).toBe('waiting');
      expect(contexts(errors)).toEqual(['crash', 'exhausted']);
      expect(errors[1].message).toContain('autoRestart is off');
      expect(closed()).toBe(1);
    }, 30_000);

    test('maxRestarts is honoured, then the worker stops instead of pulling', async () => {
      harness = await startHarness('sandboxed-max-restarts', mode);
      const queue = harness.queue<{ mode?: string; n?: number }>('jobs');
      // The counter increments before the check: maxRestarts 3 allows 2 restarts.
      const { worker: created, errors } = startWorker(harness, queue.name, { maxRestarts: 3 });
      await created.start();

      const jobs = [];
      for (let i = 0; i < 5; i++) {
        jobs.push(await queue.add('throw', { mode: 'throw' }, { attempts: 1, durable: true }));
      }
      for (const job of jobs.slice(0, 3)) await waitForState(queue, job.id, 'failed', 10_000);
      await waitUntil(() => !created.isRunning(), 'the worker to stop', 5_000);
      await Bun.sleep(1_500);

      expect(await queue.getJobState(jobs[3].id)).toBe('waiting');
      expect(await queue.getJobState(jobs[4].id)).toBe('waiting');
      expect(contexts(errors)).toEqual(['crash', 'crash', 'crash', 'exhausted']);
      expect(errors[3].message).toContain('maxRestarts (3)');
    }, 30_000);

    test('it keeps running on the threads that remain, and stops after the last', async () => {
      harness = await startHarness('sandboxed-degraded', mode);
      const queue = harness.queue<{ mode?: string; n?: number }>('jobs');
      const { worker: created, errors } = startWorker(harness, queue.name, {
        autoRestart: false,
        concurrency: 2,
      });
      await created.start();

      const first = await queue.add('throw', { mode: 'throw' }, { attempts: 1, durable: true });
      await waitForState(queue, first.id, 'failed', 5_000);
      for (let i = 0; i < 3; i++) {
        const good = await queue.add('double', { n: i }, { durable: true });
        await waitForState(queue, good.id, 'completed', 5_000);
      }
      expect(created.isRunning()).toBe(true);
      expect(created.getStats()).toMatchObject({ total: 2, idle: 1, recycled: 1 });

      const last = await queue.add('exit', { mode: 'exit' }, { attempts: 1, durable: true });
      await waitForState(queue, last.id, 'failed', 5_000);
      await waitUntil(() => !created.isRunning(), 'the worker to stop', 5_000);
      expect(contexts(errors)).toEqual(['crash', 'crash', 'exhausted']);
    }, 30_000);
  });
}
