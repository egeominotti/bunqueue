/**
 * Repro (2.9.10 compatibility): job methods that 2.9.10 completed now throw.
 *
 * - `job.updateProgress('50' | true | null | NaN | 'downloading')` made the processor
 *   throw, so the job FAILED; 2.9.10 completed it and stored Number(value).
 * - `job.changeDelay(-1)` (the `runAt - Date.now()` pattern) threw; 2.9.10 made the job
 *   ready at once. A delay above 365 days threw; 2.9.10 delayed the job.
 * - `job.updateData()` with 11 MB threw, although `add` of the same data succeeds.
 * - `changePriority` with 2,097,152, 1.5 or `'3'` threw; 2.9.10 applied it.
 * - `clearLogs(-1)` / `clearLogs(1.5)` threw; 2.9.10 cleared all / kept 1.
 * - `job.extendLock(token, 0)` threw; 2.9.10 resolved 0.
 * - `changeDelay` on a job that no longer exists threw; 2.9.10 resolved.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Job, Queue } from '../src/client';
import { jobId } from '../src/domain/types/job';
import { CoreE2eHarness, type CoreE2eMode } from './core-e2e/support/harness';

const DAY = 86_400_000;
let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function outcome(promise: Promise<unknown> | undefined): Promise<string> {
  try {
    const value = await promise;
    return value === undefined ? 'ok' : `ok(${JSON.stringify(value)})`;
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(20);
  }
  throw new Error('timed out');
}

/** Run `step` inside a processor and report its outcome, what it stored and the final state. */
async function insideProcessor(
  h: CoreE2eHarness,
  step: (job: Job<unknown>, token: string | undefined) => Promise<unknown>,
  read?: (queue: Queue<unknown>, id: string) => Promise<unknown>
): Promise<{ step: string; stored: unknown; final: string }> {
  const queue = h.queue<unknown>('compat-cmd');
  let result: string | undefined;
  let stored: unknown;
  h.worker(queue.name, async (job, token?: string) => {
    result = await outcome(step(job as Job<unknown>, token));
    stored = read ? await read(queue, String(job.id)) : undefined;
    return 'done';
  });
  const added = await queue.add('t', {}, { attempts: 1 });
  const final = await until(async () => {
    const state = await queue.getJobState(String(added.id));
    return state === 'completed' || state === 'failed' ? state : undefined;
  });
  return { step: result ?? 'not-run', stored, final };
}

async function storedProgress(h: CoreE2eHarness, id: string) {
  const job = await h.brokerManager().getJob(jobId(id));
  return { progress: job?.progress, message: job?.progressMessage };
}

for (const mode of ['embedded', 'tcp'] as CoreE2eMode[]) {
  describe(`2.9.10 job methods keep working (${mode})`, () => {
    test('updateProgress with a non-number completes the job', async () => {
      harness = await CoreE2eHarness.start(mode, 'compat-progress');
      const h = harness;
      const results: Record<string, unknown> = {};
      for (const [label, value] of [
        ["'50'", '50'],
        ['true', true],
        ['null', null],
        ['NaN', Number.NaN],
        ["'downloading'", 'downloading'],
      ] as const) {
        results[label] = await insideProcessor(
          h,
          (job) => job.updateProgress(value as never),
          (_queue, id) => storedProgress(h, id)
        );
      }
      expect(results).toEqual({
        "'50'": { step: 'ok', stored: { progress: 50, message: null }, final: 'completed' },
        true: { step: 'ok', stored: { progress: 1, message: null }, final: 'completed' },
        null: { step: 'ok', stored: { progress: 0, message: null }, final: 'completed' },
        NaN: { step: 'ok', stored: { progress: 0, message: null }, final: 'completed' },
        "'downloading'": {
          step: 'ok',
          stored: { progress: 0, message: 'downloading' },
          final: 'completed',
        },
      });
    });

    test('the progress event still carries the value the processor passed', async () => {
      harness = await CoreE2eHarness.start(mode, 'compat-progress-event');
      const queue = harness.queue('compat-progress-event');
      const events: unknown[] = [];
      const worker = harness.worker(queue.name, async (job) => {
        await job.updateProgress('50' as never);
        return 'done';
      });
      worker.on('progress', (_job, progress) => events.push(progress));
      await queue.add('t', {});
      await until(async () => (events.length > 0 ? true : undefined));
      expect(events).toEqual(['50']);
    });

    test('changeDelay, updateData, changePriority, clearLogs and extendLock', async () => {
      harness = await CoreE2eHarness.start(mode, 'compat-setters');
      const queue = harness.queue('compat-setters');
      const results: Record<string, string> = {};
      const delayed = await queue.add('a', {}, { delay: 60_000 });
      results['changeDelay(-1)'] = await outcome(delayed.changeDelay(-1));
      results['state after -1'] = await queue.getJobState(String(delayed.id));
      const far = await queue.add('b', {}, { delay: 60_000 });
      results['changeDelay(400d)'] = await outcome(far.changeDelay(400 * DAY));
      results['queue.changeJobDelay(-1)'] = await outcome(queue.changeJobDelay(String(far.id), -1));
      results['state after queue -1'] = await queue.getJobState(String(far.id));
      results['changeJobDelay missing'] = await outcome(
        queue.changeJobDelay(`missing-${crypto.randomUUID()}`, 1000)
      );
      const waiting = await queue.add('c', {}, { priority: 5 });
      results['updateData 11MB'] = await outcome(
        waiting.updateData({ blob: 'x'.repeat(11 * 1024 * 1024) })
      );
      for (const priority of [2_097_152, 1.5, '3']) {
        results[`changePriority ${String(priority)}`] = await outcome(
          waiting.changePriority({ priority: priority as number })
        );
        const stored = await harness.brokerManager().getJob(jobId(String(waiting.id)));
        results[`priority after ${String(priority)}`] = String(stored?.priority);
      }
      expect(results).toEqual({
        'changeDelay(-1)': 'ok',
        'state after -1': 'waiting',
        'changeDelay(400d)': 'ok',
        'queue.changeJobDelay(-1)': 'ok',
        'state after queue -1': 'waiting',
        'changeJobDelay missing': 'ok',
        'updateData 11MB': 'ok',
        'changePriority 2097152': 'ok',
        'priority after 2097152': '2097152',
        'changePriority 1.5': 'ok',
        'priority after 1.5': '1.5',
        'changePriority 3': 'ok',
        'priority after 3': '3',
      });
    });

    test('clearLogs(-1) clears every entry and clearLogs(1.5) keeps one', async () => {
      harness = await CoreE2eHarness.start(mode, 'compat-clearlogs');
      const h = harness;
      const results: Record<string, unknown> = {};
      for (const keep of [-1, 1.5]) {
        results[String(keep)] = await insideProcessor(
          h,
          async (job) => {
            for (const line of ['a', 'b', 'c']) await job.log(line);
            return job.clearLogs(keep);
          },
          async (queue, id) => (await queue.getJobLogs(id)).count
        );
      }
      expect(results).toEqual({
        '-1': { step: 'ok', stored: 0, final: 'completed' },
        '1.5': { step: 'ok', stored: 1, final: 'completed' },
      });
    });

    test('extendLock(token, 0) resolves 0 as on 2.9.10', async () => {
      harness = await CoreE2eHarness.start(mode, 'compat-extend');
      const result = await insideProcessor(harness, (job, token) =>
        job.extendLock(token ?? job.token ?? '', 0)
      );
      expect(result).toEqual({ step: 'ok(0)', stored: undefined, final: 'completed' });
    });
  });
}
