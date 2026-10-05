/**
 * Repro: the Worker armed its per-job processing timer with a bare
 * `setTimeout(abort, job.timeout)` whenever `job.timeout !== null`, and once that timer
 * fired it abandoned the processor's outcome, leaving the broker's timeout transition to
 * fail the job. The broker enforces a deadline only for a truthy timeout whose deadline
 * is a safe integer (`deadlineFor` in src/application/background/timeouts.ts). So a
 * timeout of 0 (legal in every producer), NaN or an infinity aborted the processor after
 * about 1 ms with nothing on the broker to settle the job, and a timeout above
 * 2^31 - 1 ms overflowed to 1 ms: the job stayed `active` with no `completed` or `failed`
 * event, in both modes, for automatic and manual processing alike.
 *
 * Producers now validate `timeout` (0..24 h), but the broker stores whatever it is given
 * (a direct manager push, an older release, another client), so the Worker must handle
 * every stored value. Those values are pushed straight into the broker here.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Worker } from '../src/client';
import type { Queue } from '../src/client';
import {
  MODES,
  closeHarness,
  startHarness,
  waitForState,
  type CoreE2eHarness,
} from './docs-guide-support';

let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  await closeHarness(harness);
  harness = null;
});

/** About 34.7 days: above the 2^31 - 1 ms that one native timer accepts. */
const BEYOND_TIMER_LIMIT = 3_000_000_000;

interface TimeoutCase {
  timeout: number;
  /** Push straight into the broker: no producer accepts this value any more. */
  stored: boolean;
}

/** Timeouts the broker never enforces. */
const UNENFORCED: TimeoutCase[] = [
  { timeout: 0, stored: false },
  { timeout: Number.NaN, stored: true },
  { timeout: Number.POSITIVE_INFINITY, stored: true },
  { timeout: Number.NEGATIVE_INFINITY, stored: true },
];

/** Timeouts the broker enforces: a fraction is rounded up, a negative one is already due. */
const ENFORCED: TimeoutCase[] = [
  { timeout: 40, stored: false },
  { timeout: 0.5, stored: false },
  { timeout: -5, stored: true },
];

/** Add one job with `timeout` (and no retry), as a producer or straight into the broker. */
async function addJob(active: CoreE2eHarness, queue: Queue, timeoutCase: TimeoutCase) {
  const { timeout, stored } = timeoutCase;
  if (!stored) return (await queue.add('job', {}, { timeout, attempts: 1 })).id;
  const job = await active.brokerManager().push(queue.name, { data: {}, timeout, maxAttempts: 1 });
  return String(job.id);
}

interface Outcome {
  event: string;
  aborted: boolean | null;
  state: string;
}

/** Process one job that works for 30 ms and report what happened within 1.5 s. */
async function runOne(
  active: CoreE2eHarness,
  queue: Queue,
  timeoutCase: TimeoutCase
): Promise<Outcome> {
  const seen: { aborted: boolean | null } = { aborted: null };
  const settled = Promise.withResolvers<string>();
  const worker = new Worker(
    queue.name,
    async (_job, context) => {
      await Bun.sleep(30);
      seen.aborted = context?.signal.aborted ?? null;
      return 'done';
    },
    active.workerOptions({ heartbeatInterval: 0 })
  );
  active.addCleanup(() => worker.close(true));
  worker.on('completed', () => settled.resolve('completed'));
  worker.on('failed', (_job, error) => settled.resolve(`failed: ${error.message}`));
  worker.on('error', (error) => settled.resolve(`error: ${error.message}`));

  const id = await addJob(active, queue, timeoutCase);
  const event = await Promise.race([settled.promise, Bun.sleep(1_500).then(() => 'none')]);
  return { event, aborted: seen.aborted, state: await queue.getJobState(id) };
}

/** A processor that waits for its signal: the broker must fail the job by its timeout. */
async function expectEnforced(active: CoreE2eHarness, queue: Queue, timeoutCase: TimeoutCase) {
  const aborted = Promise.withResolvers<boolean>();
  const worker = new Worker(
    queue.name,
    async (_job, context) => {
      const signal = context?.signal;
      await new Promise<void>((resolve) => {
        const fallback = setTimeout(resolve, 3_000);
        signal?.addEventListener('abort', () => {
          clearTimeout(fallback);
          resolve();
        });
      });
      aborted.resolve(signal?.aborted ?? false);
      throw new Error('stopped after abort');
    },
    active.workerOptions({ heartbeatInterval: 0 })
  );
  active.addCleanup(() => worker.close(true));

  const id = await addJob(active, queue, timeoutCase);
  expect(await aborted.promise).toBe(true);
  await waitForState(queue, id, 'failed', 3_000);
  expect((await queue.getJob(id))?.failedReason).toBe('Job timeout exceeded');
}

const label = ({ timeout, stored }: TimeoutCase) =>
  `timeout ${timeout}${stored ? ' (stored by the broker)' : ''}`;

for (const mode of MODES) {
  describe(`Worker job timeout [${mode}]`, () => {
    for (const timeoutCase of UNENFORCED) {
      test(`${label(timeoutCase)} is not enforced, so the processor runs and the job completes`, async () => {
        harness = await startHarness('worker-job-timeout', mode);
        const outcome = await runOne(harness, harness.queue('unenforced'), timeoutCase);
        expect(outcome).toEqual({ event: 'completed', aborted: false, state: 'completed' });
      });
    }

    test('a timeout above the native timer limit is not cut to about 1 ms', async () => {
      harness = await startHarness('worker-job-timeout', mode);
      const outcome = await runOne(harness, harness.queue('long'), {
        timeout: BEYOND_TIMER_LIMIT,
        stored: true,
      });
      expect(outcome).toEqual({ event: 'completed', aborted: false, state: 'completed' });
    });

    for (const timeoutCase of ENFORCED) {
      test(`${label(timeoutCase)} aborts the processor and the broker fails the job`, async () => {
        harness = await startHarness('worker-job-timeout', mode);
        await expectEnforced(harness, harness.queue('enforced'), timeoutCase);
      });
    }

    test('manual processing completes a job whose timeout is 0', async () => {
      harness = await startHarness('worker-job-timeout', mode);
      const queue = harness.queue('manual');
      const seen: { aborted: boolean | null } = { aborted: null };
      const worker = new Worker(
        queue.name,
        async (_job, context) => {
          await Bun.sleep(30);
          seen.aborted = context?.signal.aborted ?? null;
          return 'done';
        },
        harness.workerOptions({ heartbeatInterval: 0, autorun: false })
      );
      harness.addCleanup(() => worker.close(true));

      const added = await queue.add('job', {}, { timeout: 0, attempts: 1 });
      const job = await worker.getNextJob();
      expect(String(job?.id)).toBe(added.id);
      await worker.processJobManually(job!);
      expect(seen.aborted).toBe(false);
      await waitForState(queue, added.id, 'completed', 1_500);
    });
  });
}
