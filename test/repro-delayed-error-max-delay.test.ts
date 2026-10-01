/**
 * Repro: DelayedError ignored backoff.maxDelay.
 *
 * When a processor throws DelayedError, the worker moves the job back to
 * delayed using `job.backoff || 1000`, the numeric base delay. The per-job cap
 * `backoff.maxDelay` was ignored, so a job configured with a 60s base delay and
 * a 2s cap was delayed for a whole minute in both embedded and TCP mode.
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

const BASE_DELAY = 60_000;
const MAX_DELAY = 2_000;

let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  await closeHarness(harness);
  harness = null;
});

for (const mode of MODES) {
  describe(`DelayedError honors backoff.maxDelay [${mode}]`, () => {
    test('the job is delayed by at most maxDelay', async () => {
      harness = await startHarness('delayed-error-max-delay', mode);
      const queue = harness.queue(`delayed-error-max-delay-${mode}`);
      let thrownAt = 0;
      const worker = harness.worker(
        queue.name,
        () => {
          thrownAt = Date.now();
          throw new DelayedError('not yet');
        },
        { concurrency: 1 }
      );
      worker.on('error', () => {
        // The delayed state and runAt below are the authoritative outcome.
      });

      const job = await queue.add(
        'delayed-error',
        {},
        { backoff: { type: 'fixed', delay: BASE_DELAY, maxDelay: MAX_DELAY }, durable: true }
      );
      await waitForState(queue, job.id, 'delayed', 10_000);
      await worker.close(true);

      const stored = await harness.brokerManager().getJob(jobId(job.id));
      expect(stored).not.toBeNull();
      expect(stored!.runAt - thrownAt).toBeLessThanOrEqual(MAX_DELAY + 1_000);
    }, 20_000);
  });
}
