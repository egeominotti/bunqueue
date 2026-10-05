/**
 * Repro (real worker threads, embedded broker): a SandboxedWorker thread received jobs
 * before its processor had loaded.
 *
 * The thread wrapper installed its message handler only after `await import(processor)`,
 * and Bun drops a message that reaches a worker with no handler. After a crash the pool
 * restarted the thread without waiting for it, and the new thread record was idle at
 * once: the next job was posted to it while the processor still loaded, dropped, and
 * left `active` for good under `timeout: 0` (with a timeout, each such job timed out and
 * burned a restart). start() waited at most 5 s for a thread, so a processor that took
 * longer to load lost its first job the same way. A restarted thread whose processor
 * failed to load was handed a job too, which its crash then failed.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SandboxedWorker } from '../src/client/sandboxed';
import { cleanupWrapperScript, createWrapperScript } from '../src/client/sandboxed/wrapper';
import { type CoreE2eHarness, closeHarness, startHarness, waitUntil } from './docs-guide-support';

type ReportedError = Error & { context?: string };
type JobData = { mode?: string; n?: number };

let harness: CoreE2eHarness | null = null;
let worker: SandboxedWorker | null = null;

afterEach(async () => {
  await worker?.stop(true).catch(() => undefined);
  worker = null;
  await closeHarness(harness);
  harness = null;
});

interface SlowProcessor {
  path: string;
  /** Once this file exists, every later load of the processor throws. */
  broken: string;
  /** Every live thread appends to it every 20 ms, from the start of its load. */
  beat: string;
}

/**
 * A processor whose module takes `loadMs` to load (a top-level await). Its job exits
 * the thread with `mode: 'exit'`, else returns `n * 2`.
 */
function slowProcessor(active: CoreE2eHarness, loadMs: number): SlowProcessor {
  const path = join(active.dataDir, 'slow-processor.ts');
  const broken = join(active.dataDir, 'processor-broken');
  const beat = join(active.dataDir, 'thread-beat');
  writeFileSync(beat, '');
  writeFileSync(
    path,
    `import { appendFileSync, existsSync } from 'node:fs';
setInterval(() => appendFileSync(${JSON.stringify(beat)}, '.'), 20);
await Bun.sleep(${loadMs});
if (existsSync(${JSON.stringify(broken)})) throw new Error('processor failed to load');
export default async (job: { data: { mode?: string; n?: number } }) => {
  if (job.data.mode === 'exit') process.exit(3);
  return (job.data.n ?? 0) * 2;
};\n`
  );
  return { path, broken, beat };
}

function startWorker(
  queue: string,
  processor: string,
  options: { maxRestarts?: number } = {}
): { worker: SandboxedWorker; errors: ReportedError[] } {
  const errors: ReportedError[] = [];
  const created = new SandboxedWorker(queue, {
    processor,
    timeout: 0, // A dropped job would stay active for good.
    ...options,
  });
  created.on('error', (error) => errors.push(error));
  worker = created;
  return { worker: created, errors };
}

const contexts = (errors: ReportedError[]) => errors.map((error) => error.context);

/** Wait for `id` to reach `state`; on timeout, name the state it was left in. */
async function expectState(
  queue: { getJobState(id: string): Promise<string> },
  id: string,
  state: string,
  timeoutMs = 5_000
): Promise<void> {
  let last = 'unknown';
  await waitUntil(
    async () => (last = await queue.getJobState(id)) === state,
    `job ${id} to reach '${state}'`,
    timeoutMs
  ).catch(() => {
    throw new Error(`job ${id} was left '${last}' instead of reaching '${state}'`);
  });
}

describe('SandboxedWorker threads get jobs only once their processor has loaded', () => {
  test('a thread restarted after a crash runs the next jobs instead of dropping them', async () => {
    harness = await startHarness('sandboxed-restart-ready', 'embedded');
    const queue = harness.queue<JobData>('jobs');
    const { worker: created, errors } = startWorker(queue.name, slowProcessor(harness, 400).path);
    await created.start();

    const exiting = await queue.add('exit', { mode: 'exit' }, { attempts: 1, durable: true });
    const next = await queue.add('double', { n: 4 }, { durable: true });
    const after = await queue.add('double', { n: 5 }, { durable: true });

    await expectState(queue, exiting.id, 'failed');
    await expectState(queue, next.id, 'completed');
    await expectState(queue, after.id, 'completed');
    expect((await queue.getJob(next.id))?.returnvalue).toBe(8);
    expect((await queue.getJob(after.id))?.returnvalue).toBe(10);
    expect(contexts(errors)).toEqual(['crash']);
  }, 30_000);

  test('a thread still loading when start() resolves gets its first job once loaded', async () => {
    harness = await startHarness('sandboxed-start-ready', 'embedded');
    const queue = harness.queue<JobData>('jobs');
    // Longer than the 5 s start() waits for a thread's `ready`.
    const { worker: created, errors } = startWorker(queue.name, slowProcessor(harness, 5_500).path);
    const job = await queue.add('double', { n: 3 }, { durable: true });

    await created.start();
    await expectState(queue, job.id, 'completed');
    expect((await queue.getJob(job.id))?.returnvalue).toBe(6);
    expect(errors).toEqual([]);
  }, 30_000);

  test('a restart whose processor fails to load is a crash and is handed no job', async () => {
    harness = await startHarness('sandboxed-restart-load-fail', 'embedded');
    const queue = harness.queue<JobData>('jobs');
    const processor = slowProcessor(harness, 200);
    const { worker: created, errors } = startWorker(queue.name, processor.path, {
      maxRestarts: 3,
    });
    await created.start();
    writeFileSync(processor.broken, '');

    const exiting = await queue.add('exit', { mode: 'exit' }, { attempts: 1, durable: true });
    const pending = await queue.add('double', { n: 1 }, { attempts: 1, durable: true });

    await expectState(queue, exiting.id, 'failed');
    await waitUntil(() => !created.isRunning(), 'the worker to stop', 5_000);
    // The crashed thread's two restarts failed to load: neither was given the job.
    expect(await queue.getJobState(pending.id)).toBe('waiting');
    expect(contexts(errors)).toEqual(['crash', 'crash', 'crash', 'exhausted']);
    expect(errors[1].message).toContain('processor failed to load');
    expect(errors[2].message).toContain('processor failed to load');
  }, 30_000);

  test('stop() while a restarted thread is loading leaves no thread running', async () => {
    harness = await startHarness('sandboxed-restart-stop', 'embedded');
    const queue = harness.queue<JobData>('jobs');
    const processor = slowProcessor(harness, 400);
    const { worker: created } = startWorker(queue.name, processor.path);
    await created.start();

    const exiting = await queue.add('exit', { mode: 'exit' }, { attempts: 1, durable: true });
    await expectState(queue, exiting.id, 'failed');
    // The restarted thread is loading its processor now.
    await created.stop();
    expect(created.getStats().total).toBe(0);

    await Bun.sleep(200);
    const beats = statSync(processor.beat).size;
    await Bun.sleep(300);
    expect(statSync(processor.beat).size).toBe(beats);
  }, 30_000);

  test('the thread wrapper keeps a job posted while its processor loads', async () => {
    harness = await startHarness('sandboxed-wrapper-ready', 'embedded');
    const processor = slowProcessor(harness, 400);
    const wrapper = await createWrapperScript('restart-ready', processor.path);
    const thread = new Worker(wrapper);
    try {
      const result = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the job was dropped')), 3_000);
        thread.onmessage = (event: MessageEvent<{ type: string; result?: unknown }>) => {
          if (event.data.type !== 'result') return;
          clearTimeout(timer);
          resolve(event.data.result);
        };
      });
      thread.postMessage({
        type: 'job',
        job: { id: '1', name: 'double', data: { n: 21 }, queue: 'q', attempts: 0 },
      });
      expect(await result).toBe(42);
    } finally {
      thread.terminate();
      await cleanupWrapperScript(wrapper);
    }
  }, 30_000);
});
