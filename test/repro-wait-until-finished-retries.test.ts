import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { QueueEvents } from '../src/client';
import { CoreE2eHarness } from './core-e2e/support/harness';

// A failed attempt that will be retried is not the end of a job. Found while verifying
// bunqueue-client 0.2.1 against bunqueue 2.9.8: a job added with `attempts: 3` that
// failed twice and completed on its third attempt made `waitJobUntilFinished` reject
// with the first attempt's error ("boom 1"), because the broker broadcasts a `failed`
// event (marked `terminal: false`) for every retried attempt and the waiter settled on
// the first one. BullMQ only reports `failed` once retries are exhausted, and its
// `job.waitUntilFinished` settles on the final outcome.
//
// The same audit found two more gaps in `job.waitUntilFinished`: over TCP it waits on
// the broker's WaitJob command, which only settles on completion, so a job that failed
// in milliseconds held the caller for the whole TTL and then reported a timeout; and in
// embedded mode a call without QueueEvents (`null`, as the flow guide passes) threw
// "null is not an object" instead of waiting. test/repro-wait-tcp-broker.test.ts covers
// the TCP timing in detail.

// Waits use generous 10s TTLs: a failing wait must surface as its assertion, not a test
// timeout, and a loaded CI container must not turn a slow retry into a timeout.
setDefaultTimeout(30_000);

let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function queueEvents(h: CoreE2eHarness, name: string): QueueEvents {
  const events = new QueueEvents(
    name,
    h.mode === 'tcp'
      ? { embedded: false, connection: h.connection() }
      : { embedded: true, dataPath: h.dataPath }
  );
  h.addCleanup(() => events.close());
  return events;
}

/** A processor that throws on its first `failures` calls, then returns the attempt number. */
function flaky(failures: number) {
  let calls = 0;
  return async () => {
    calls++;
    if (calls <= failures) throw new Error(`attempt ${calls} failed`);
    return { attempt: calls };
  };
}

for (const mode of ['embedded', 'tcp'] as const) {
  describe(`waiting for a job that still has retries [${mode}]`, () => {
    test('Queue.waitJobUntilFinished resolves when a later attempt completes', async () => {
      harness = await CoreE2eHarness.start(mode, 'wait-retry-queue');
      const queue = harness.queue('flaky');
      const events = queueEvents(harness, queue.name);
      await events.waitUntilReady();
      harness.worker(queue.name, flaky(2));

      const job = await queue.add('flaky', {}, { attempts: 3, backoff: 10, durable: true });

      expect(await queue.waitJobUntilFinished(job.id, events, 10_000)).toEqual({ attempt: 3 });
    });

    test('job.waitUntilFinished resolves when a later attempt completes', async () => {
      harness = await CoreE2eHarness.start(mode, 'wait-retry-job');
      const queue = harness.queue('flaky');
      const events = queueEvents(harness, queue.name);
      await events.waitUntilReady();
      harness.worker(queue.name, flaky(1));

      const job = await queue.add('flaky', {}, { attempts: 2, backoff: 10, durable: true });

      expect(await job.waitUntilFinished(events, 10_000)).toEqual({ attempt: 2 });
    });

    test('the wait rejects once, with the last attempt error, when retries run out', async () => {
      harness = await CoreE2eHarness.start(mode, 'wait-retry-exhausted');
      const queue = harness.queue('doomed');
      const events = queueEvents(harness, queue.name);
      await events.waitUntilReady();
      harness.worker(queue.name, flaky(Number.POSITIVE_INFINITY));

      const job = await queue.add('doomed', {}, { attempts: 3, backoff: 10, durable: true });

      await expect(queue.waitJobUntilFinished(job.id, events, 10_000)).rejects.toThrow(
        'attempt 3 failed'
      );
    });

    test('job.waitUntilFinished rejects with the last attempt error when retries run out', async () => {
      harness = await CoreE2eHarness.start(mode, 'wait-retry-job-exhausted');
      const queue = harness.queue('doomed');
      const events = queueEvents(harness, queue.name);
      await events.waitUntilReady();
      harness.worker(queue.name, flaky(Number.POSITIVE_INFINITY));

      const job = await queue.add('doomed', {}, { attempts: 3, backoff: 10, durable: true });

      await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow('attempt 3 failed');
    });

    test('job.waitUntilFinished without QueueEvents resolves when a later attempt completes', async () => {
      harness = await CoreE2eHarness.start(mode, 'wait-retry-no-events');
      const queue = harness.queue('flaky');
      harness.worker(queue.name, flaky(1));

      const job = await queue.add('flaky', {}, { attempts: 2, backoff: 10, durable: true });

      expect(await job.waitUntilFinished(null, 10_000)).toEqual({ attempt: 2 });
    });

    test('job.waitUntilFinished without QueueEvents reports a final failure, not a timeout', async () => {
      harness = await CoreE2eHarness.start(mode, 'wait-exhausted-no-events');
      const queue = harness.queue('doomed');
      harness.worker(queue.name, flaky(Number.POSITIVE_INFINITY));

      const job = await queue.add('doomed', {}, { attempts: 2, backoff: 10, durable: true });

      // Both attempts fail within milliseconds: the wait reports it long before its TTL.
      const started = performance.now();
      await expect(job.waitUntilFinished(null, 10_000)).rejects.toThrow('attempt 2 failed');
      expect(performance.now() - started).toBeLessThan(5_000);
    });
  });
}
