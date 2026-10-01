/**
 * Repro: DelayedError with backoff.maxDelay = 0 spins without waiting.
 *
 * `maxDelay: 0` means "retry failures immediately". DelayedError is not a
 * failure and never counts an attempt, so capping its postponement at 0 turned
 * a processor that keeps throwing DelayedError into a tight loop: pull, throw,
 * move to delayed with 0 ms, pull again, with nothing to ever stop it.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { DelayedError } from '../src/client/errors';
import { jobId } from '../src/domain/types/job';
import {
  type CoreE2eHarness,
  MODES,
  closeHarness,
  startHarness,
  waitForState,
} from './docs-guide-support';

let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  await closeHarness(harness);
  harness = null;
});

for (const mode of MODES) {
  describe(`DelayedError never spins with maxDelay 0 [${mode}]`, () => {
    test('the job is postponed and the processor is not called again right away', async () => {
      harness = await startHarness('delayed-error-zero-cap', mode);
      const queue = harness.queue(`delayed-error-zero-cap-${mode}`);
      let calls = 0;
      let thrownAt = 0;
      const worker = harness.worker(
        queue.name,
        () => {
          calls++;
          thrownAt = Date.now();
          throw new DelayedError('not yet');
        },
        { concurrency: 1 }
      );
      worker.on('error', () => {
        // The delayed state, runAt and call count below are authoritative.
      });

      const job = await queue.add(
        'delayed-error',
        {},
        { backoff: { type: 'fixed', delay: 60_000, maxDelay: 0 }, durable: true }
      );
      await waitForState(queue, job.id, 'delayed', 10_000);
      await Bun.sleep(300);

      expect(calls).toBe(1);
      const stored = await harness.brokerManager().getJob(jobId(job.id));
      expect(stored).not.toBeNull();
      expect(stored!.runAt - thrownAt).toBeGreaterThanOrEqual(1_000);
      await worker.close(true);
    }, 20_000);
  });
}
