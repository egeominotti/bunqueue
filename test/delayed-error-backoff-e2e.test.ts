/**
 * End-to-end coverage for the DelayedError re-delay and the object-form backoff
 * a Worker sees, against a real broker in both runtimes. TCP workers used to
 * receive only the numeric base backoff, so neither `job.opts.backoff` nor the
 * DelayedError path could see `maxDelay`.
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
  describe(`DelayedError and object-form backoff [${mode}]`, () => {
    test('the processor sees backoff.maxDelay in job.opts.backoff', async () => {
      harness = await startHarness('worker-backoff-opts', mode);
      const queue = harness.queue(`worker-backoff-opts-${mode}`);
      const backoff = { type: 'exponential', delay: 300, maxDelay: 1_500 } as const;
      let seen: unknown;
      harness.worker(queue.name, (job) => {
        seen = job.opts.backoff;
        return 'ok';
      });

      const job = await queue.add('opts', {}, { backoff, durable: true });
      await waitForState(queue, job.id, 'completed', 10_000);
      expect(seen).toEqual(backoff);
    }, 20_000);

    test('a numeric backoff stays numeric in job.opts.backoff', async () => {
      harness = await startHarness('worker-backoff-numeric', mode);
      const queue = harness.queue(`worker-backoff-numeric-${mode}`);
      let seen: unknown;
      harness.worker(queue.name, (job) => {
        seen = job.opts.backoff;
        return 'ok';
      });

      const job = await queue.add('opts', {}, { backoff: 750, durable: true });
      await waitForState(queue, job.id, 'completed', 10_000);
      expect(seen).toBe(750);
    }, 20_000);

    // Spec change: maxDelay 0 does not apply to DelayedError; a zero wait spins.
    // The job used to be re-queued as immediately ready; it now waits its base
    // delay, and the attempt is still not counted.
    test('maxDelay 0 still postpones a DelayedError job by its base delay', async () => {
      harness = await startHarness('delayed-error-zero-cap', mode);
      const queue = harness.queue(`delayed-error-zero-cap-${mode}`);
      const baseDelay = 1_200;
      const starts: number[] = [];
      const worker = harness.worker(queue.name, () => {
        starts.push(Date.now());
        if (starts.length === 1) throw new DelayedError('not yet');
        return 'done';
      });
      worker.on('error', () => {
        // The delayed and completed states below are the authoritative outcome.
      });

      const job = await queue.add(
        'zero-cap',
        {},
        { backoff: { type: 'fixed', delay: baseDelay, maxDelay: 0 }, durable: true }
      );
      await waitForState(queue, job.id, 'delayed', 10_000);
      expect(starts).toHaveLength(1);
      await waitForState(queue, job.id, 'completed', 10_000);
      expect(starts).toHaveLength(2);
      // runAt is set after the throw on the same clock, so the gap is never
      // shorter than the base delay.
      expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(baseDelay);
      const stored = await harness.brokerManager().getJob(jobId(job.id));
      expect(stored?.attempts ?? 0).toBe(0);
    }, 20_000);
  });
}
