import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { QueueEvents } from '../src/client';
import type { Job, JobOptions, Queue } from '../src/client';
import { CoreE2eHarness } from './core-e2e/support/harness';

// Every Job object waits through one implementation (src/client/jobWait.ts). These
// cases cover the Job sources that test/repro-wait-until-finished-retries.test.ts does
// not reach (getJob, addBulk, FlowProducer, DLQ entries, Worker events), the `terminal`
// flag QueueEvents now puts on `failed` payloads, and a TCP QueueEvents that is still
// subscribing when the wait starts.

// Waits use generous TTLs (10s) where timing is not the point, so a loaded CI container
// does not turn a slow retry into a timeout; a failing wait must still surface as its
// assertion, not as a test timeout. Durations are asserted only where timing is the point.
setDefaultTimeout(30_000);

type Data = { failures: number };

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

/** Fails each job's first `data.failures` attempts, then returns the attempt number. */
function processor() {
  const attempts = new Map<string, number>();
  return async (job: Job<Data>) => {
    const attempt = (attempts.get(job.id) ?? 0) + 1;
    attempts.set(job.id, attempt);
    if (attempt <= job.data.failures) throw new Error(`attempt ${attempt} failed`);
    return { attempt };
  };
}

function outcome(wait: Promise<unknown>): Promise<{ value: unknown } | { error: string }> {
  return wait.then(
    (value) => ({ value }),
    (error: unknown) => ({ error: (error as Error).message })
  );
}

type JobSource = (
  h: CoreE2eHarness,
  queue: Queue<Data>,
  data: Data,
  opts: JobOptions
) => Promise<Job<Data>>;

const sources: Record<string, JobSource> = {
  'Queue.getJob': async (_h, queue, data, opts) => {
    const job = await queue.getJob((await queue.add('job', data, opts)).id);
    if (!job) throw new Error('getJob returned null');
    return job;
  },
  'Queue.addBulk': async (_h, queue, data, opts) =>
    (await queue.addBulk([{ name: 'job', data, opts }]))[0],
  'FlowProducer.add': async (h, queue, data, opts) =>
    (await h.flow().add<Data>({ name: 'job', queueName: queue.name, data, opts })).job,
};

for (const mode of ['embedded', 'tcp'] as const) {
  describe(`waitUntilFinished across Job sources [${mode}]`, () => {
    test('QueueEvents marks a retried attempt as a non-terminal failure', async () => {
      harness = await CoreE2eHarness.start(mode, 'wait-paths-terminal');
      const queue = harness.queue<Data>('doomed');
      const events = queueEvents(harness, queue.name);
      await events.waitUntilReady();
      const failures: Array<{ failedReason: string; terminal?: boolean }> = [];
      const final = new Promise<void>((resolve) => {
        events.on('failed', ({ failedReason, terminal }) => {
          failures.push({ failedReason, terminal });
          if (terminal) resolve();
        });
      });
      harness.worker(queue.name, processor());

      await queue.add('doomed', { failures: 99 }, { attempts: 2, backoff: 10, durable: true });
      await final;

      expect(failures).toEqual([
        { failedReason: 'attempt 1 failed', terminal: false },
        { failedReason: 'attempt 2 failed', terminal: true },
      ]);
    });

    for (const [source, create] of Object.entries(sources)) {
      test(`${source} jobs settle on the final outcome, with or without QueueEvents`, async () => {
        harness = await CoreE2eHarness.start(mode, 'wait-paths-source');
        const queue = harness.queue<Data>('paths');
        const events = queueEvents(harness, queue.name);
        await events.waitUntilReady();
        const opts = { backoff: 10, durable: true };
        const recovers = await create(harness, queue, { failures: 2 }, { ...opts, attempts: 3 });
        const doomed = await create(harness, queue, { failures: 99 }, { ...opts, attempts: 2 });

        // The waits start before the first attempt runs, so every retried attempt reaches them.
        const waits = Promise.all([
          outcome(recovers.waitUntilFinished(events, 10_000)),
          outcome(recovers.waitUntilFinished(null, 10_000)),
          outcome(doomed.waitUntilFinished(events, 10_000)),
          outcome(doomed.waitUntilFinished(null, 10_000)),
        ]);
        harness.worker(queue.name, processor());

        expect(await waits).toEqual([
          { value: { attempt: 3 } },
          { value: { attempt: 3 } },
          { error: 'attempt 2 failed' },
          { error: 'attempt 2 failed' },
        ]);
      });
    }

    test('a DLQ entry job reports its failure reason, not a timeout', async () => {
      harness = await CoreE2eHarness.start(mode, 'wait-paths-dlq');
      const queue = harness.queue<Data>('dlq');
      const events = queueEvents(harness, queue.name);
      await events.waitUntilReady();
      harness.worker(queue.name, processor());
      const job = await queue.add('doomed', { failures: 99 }, { attempts: 1, durable: true });
      await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow('attempt 1 failed');

      const [entry] = await queue.getDlqAsync();
      expect(entry.job.id).toBe(job.id);
      // The job has already failed: both waits settle at once, long before their TTL.
      const started = performance.now();
      await expect(entry.job.waitUntilFinished(events, 10_000)).rejects.toThrow('attempt 1 failed');
      await expect(entry.job.waitUntilFinished(null, 10_000)).rejects.toThrow('attempt 1 failed');
      expect(performance.now() - started).toBeLessThan(2_000);
    });

    test('Worker event jobs wait past the attempt that failed', async () => {
      harness = await CoreE2eHarness.start(mode, 'wait-paths-worker');
      const queue = harness.queue<Data>('worker');
      const events = queueEvents(harness, queue.name);
      await events.waitUntilReady();
      const worker = harness.worker(queue.name, processor());
      const waits: Partial<Record<string, Promise<unknown[]>>> = {};
      const registered = Promise.withResolvers<undefined>();
      worker.on('failed', (job) => {
        // Only the first failure of each job starts waits; the job has a retry left then.
        waits[job.name] ??= Promise.all([
          outcome(job.waitUntilFinished(events, 10_000)),
          outcome(job.waitUntilFinished(null, 10_000)),
        ]);
        if (waits.recovers && waits.doomed) registered.resolve(undefined);
      });

      const opts = { attempts: 2, backoff: 10, durable: true };
      await queue.add('recovers', { failures: 1 }, opts);
      await queue.add('doomed', { failures: 99 }, opts);
      await registered.promise;

      expect(await waits.recovers).toEqual([{ value: { attempt: 2 } }, { value: { attempt: 2 } }]);
      expect(await waits.doomed).toEqual([
        { error: 'attempt 2 failed' },
        { error: 'attempt 2 failed' },
      ]);
    });

    test('a wait does not miss a completion while its QueueEvents is still subscribing', async () => {
      harness = await CoreE2eHarness.start(mode, 'wait-paths-ready');
      const queue = harness.queue<Data>('fast');
      harness.worker(queue.name, processor());

      for (let round = 0; round < 20; round++) {
        const job = await queue.add('fast', { failures: 0 }, { durable: true });
        // Created after the job and never awaited: the wait must not read the job state
        // before the subscription can report what happens after that read.
        const events = queueEvents(harness, queue.name);
        expect(await job.waitUntilFinished(events, 10_000)).toEqual({ attempt: 1 });
        events.close();
      }
    });
  });
}
