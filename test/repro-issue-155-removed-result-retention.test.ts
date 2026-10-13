/**
 * Repro for GitHub issue #155, part A, the case 7147e978 left open: a wait for a job
 * added with `removeOnComplete: true` that completes BEFORE the wait reaches the broker.
 *
 * 7147e978 hands the result to a WaitJob hold that is registered when the job completes.
 * In the issue's request/reply script (`add()` then `waitUntilFinished()` without
 * QueueEvents, idle worker) about half of the jobs complete before the first hold
 * arrives: memory and SQLite keep nothing for such a job, so the wait rejected with
 * `Job <id> not found` although the job completed with a result. With QueueEvents a wait
 * started after the completion rejected the same way (the event is not replayed).
 *
 * The broker now keeps the result of a job removed on completion for a short, bounded
 * time, in memory only, and its completion lookup (WaitJob, the embedded state read)
 * answers with it: a wait settles on the job's real outcome whether it started before
 * or after the completion. The record never outlives an obliterate, a remove() of the
 * job, a new generation under the same custom ID, or a broker restart.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { QueueEvents } from '../src/client';
import { CoreE2eHarness } from './core-e2e/support/harness';

setDefaultTimeout(60_000);

let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

type Settled = { value: unknown } | { error: string } | 'pending';

function settledWithin(promise: Promise<unknown>, ms: number): Promise<Settled> {
  return Promise.race([
    promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error: (error as Error).message })
    ),
    Bun.sleep(ms).then(() => 'pending' as const),
  ]);
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let elapsed = 0; elapsed < 10_000; elapsed += 10) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error(`${what} not reached within 10s`);
}

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

for (const mode of ['embedded', 'tcp'] as const) {
  describe(`issue #155 A: a job removed on completion before the wait started [${mode}]`, () => {
    test('a wait without QueueEvents resolves with the result', async () => {
      harness = await CoreE2eHarness.start(mode, 'i155r-null');
      const queue = harness.queue('null');
      harness.worker(queue.name, (job) => ({ answer: (job.data as { n: number }).n * 2 }));
      const job = await queue.add('tool', { n: 21 }, { removeOnComplete: true, durable: true });
      await until(async () => (await queue.getJobState(job.id)) === 'unknown', 'removal');

      expect(await settledWithin(job.waitUntilFinished(null, 10_000), 8_000)).toEqual({
        value: { answer: 42 },
      });
    });

    test('a wait with QueueEvents resolves with the result', async () => {
      harness = await CoreE2eHarness.start(mode, 'i155r-events');
      const queue = harness.queue('events');
      const events = queueEvents(harness, queue.name);
      await events.waitUntilReady();
      harness.worker(queue.name, () => 'done');
      const job = await queue.add('tool', {}, { removeOnComplete: true, durable: true });
      await until(async () => (await queue.getJobState(job.id)) === 'unknown', 'removal');

      expect(await settledWithin(job.waitUntilFinished(events, 10_000), 8_000)).toEqual({
        value: 'done',
      });
    });

    test('a processor that returns nothing completes the wait with undefined', async () => {
      harness = await CoreE2eHarness.start(mode, 'i155r-undefined');
      const queue = harness.queue('undefined');
      harness.worker(queue.name, () => undefined);
      const job = await queue.add('tool', {}, { removeOnComplete: true, durable: true });
      await until(async () => (await queue.getJobState(job.id)) === 'unknown', 'removal');

      expect(await settledWithin(job.waitUntilFinished(null, 10_000), 8_000)).toEqual({
        value: undefined,
      });
    });

    test("the issue's request/reply loop: every wait gets its own result", async () => {
      harness = await CoreE2eHarness.start(mode, 'i155r-loop');
      const queue = harness.queue('loop');
      harness.worker(queue.name, (job) => ({ answer: (job.data as { n: number }).n * 2 }));
      await Bun.sleep(200);

      const outcomes: Settled[] = [];
      for (let n = 0; n < 40; n++) {
        const job = await queue.add('tool', { n }, { removeOnComplete: true, attempts: 1 });
        outcomes.push(await settledWithin(job.waitUntilFinished(null, 10_000), 8_000));
      }

      expect(outcomes).toEqual(Array.from({ length: 40 }, (_, n) => ({ value: { answer: n * 2 } })));
    });

    test('a new generation under the same custom ID never gets the old result', async () => {
      harness = await CoreE2eHarness.start(mode, 'i155r-reuse');
      const queue = harness.queue('reuse');
      const manager = harness.brokerManager();
      const first = await queue.add(
        'tool',
        { n: 1 },
        { jobId: 'same-id', removeOnComplete: true, durable: true }
      );
      const pulledFirst = await manager.pull(queue.name);
      await manager.ack(pulledFirst!.id, 'first-result');
      expect(await queue.getJobState(first.id)).toBe('unknown');

      const second = await queue.add(
        'tool',
        { n: 2 },
        { jobId: 'same-id', removeOnComplete: true, durable: true }
      );
      expect(second.id).toBe(first.id);
      const wait = settledWithin(second.waitUntilFinished(null, 10_000), 8_000);
      await Bun.sleep(100);
      const pulledSecond = await manager.pull(queue.name);
      await manager.ack(pulledSecond!.id, 'second-result');

      expect(await wait).toEqual({ value: 'second-result' });
    });

    test('obliterate drops the retained result', async () => {
      harness = await CoreE2eHarness.start(mode, 'i155r-obliterate');
      const queue = harness.queue('obliterate');
      const manager = harness.brokerManager();
      const job = await queue.add('tool', {}, { removeOnComplete: true, durable: true });
      const pulled = await manager.pull(queue.name);
      await manager.ack(pulled!.id, 'secret-result');

      await queue.obliterateAsync();

      expect(await settledWithin(job.waitUntilFinished(null, 3_000), 6_000)).toEqual({
        error: `Job ${job.id} not found`,
      });
    });

    test('remove() drops the retained result', async () => {
      harness = await CoreE2eHarness.start(mode, 'i155r-remove');
      const queue = harness.queue('remove');
      const manager = harness.brokerManager();
      const job = await queue.add('tool', {}, { removeOnComplete: true, durable: true });
      const pulled = await manager.pull(queue.name);
      await manager.ack(pulled!.id, 'secret-result');

      expect(await settledWithin(job.remove(), 5_000)).toEqual({ value: undefined });

      expect(await settledWithin(job.waitUntilFinished(null, 3_000), 6_000)).toEqual({
        error: `Job ${job.id} not found`,
      });
    });

    test('the retained result is memory only: a restart drops it', async () => {
      harness = await CoreE2eHarness.start(mode, 'i155r-restart');
      const queue = harness.queue('restart');
      const name = queue.name;
      const manager = harness.brokerManager();
      await queue.add('tool', {}, { removeOnComplete: true, durable: true });
      const pulled = await manager.pull(name);
      await manager.ack(pulled!.id, 'secret-result');

      await harness.restartBroker();
      const restarted = harness.brokerManager();

      expect(await restarted.getCompletionAsync(pulled!.id)).toEqual({
        found: false,
        result: undefined,
      });
    });
  });
}
