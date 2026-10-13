/**
 * Repro for GitHub issue #155: "read the result, then make sure the job is gone".
 *
 * A. `waitUntilFinished` without QueueEvents resolved with `undefined` for a job added
 *    with `removeOnComplete: true`, although its WaitJob hold was registered on the
 *    broker when the job completed. The hold woke up on the `completed` event, then
 *    re-read the result from `completedJobs`/SQLite, where a job removed on completion
 *    keeps nothing, and answered `{ completed: true, result: undefined }`. The result
 *    travels in the `completed` event that wakes the waiter, so the hold must answer
 *    with it (single ACK and batch ACK paths).
 *
 * B. `job.remove()` on a completed job answered ok and removed nothing: the client maps
 *    it to `Cancel`, `cancelJob` handled only queued jobs, and the client ignored the
 *    broker's `ok: false`. The completed job kept its data and result until retention.
 *    `Cancel` now removes a completed job (row, result, in-memory projections) while
 *    keeping the payload-free completion proof dependents need, exactly as
 *    `removeOnComplete` would have done; `remove()` rejects when the job exists but
 *    cannot be removed (an active job), and still resolves when the job is missing.
 */
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { QueueManager } from '../src/application/queueManager';
import { jobId } from '../src/domain/types/job';
import { CoreE2eHarness } from './core-e2e/support/harness';

setDefaultTimeout(30_000);

let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

type Settled = { value: unknown } | { error: string } | 'pending';

/** The promise's outcome, or 'pending' when it has not settled within `ms`. */
function settledWithin(promise: Promise<unknown>, ms: number): Promise<Settled> {
  return Promise.race([
    promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error: (error as Error).message })
    ),
    Bun.sleep(ms).then(() => 'pending' as const),
  ]);
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let elapsed = 0; elapsed < 10_000; elapsed += 5) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  throw new Error(`${what} not reached within 10s`);
}

function completionWaiters(manager: QueueManager): number {
  return (manager as unknown as { eventsManager: { completionWaiterCount: number } })
    .eventsManager.completionWaiterCount;
}

/**
 * Over TCP the wait reads the job once, then holds WaitJob on the broker: complete the
 * job only once that hold is registered, so the hold (not a later read) sees it.
 */
async function holdRegistered(h: CoreE2eHarness, manager: QueueManager): Promise<void> {
  if (h.mode === 'tcp') await until(() => completionWaiters(manager) > 0, 'WaitJob hold');
  else await Bun.sleep(20);
}

/** Rows SQLite still holds for the job, read through an independent connection. */
function sqliteRows(dataPath: string, id: string): { jobs: number; results: number } {
  const db = new Database(dataPath, { readonly: true });
  try {
    const count = (sql: string) => (db.query(sql).get(id) as { n: number }).n;
    return {
      jobs: count('SELECT COUNT(*) AS n FROM jobs WHERE id = ?'),
      results: count('SELECT COUNT(*) AS n FROM job_results WHERE job_id = ?'),
    };
  } finally {
    db.close();
  }
}

for (const mode of ['embedded', 'tcp'] as const) {
  describe(`issue #155 A: a wait returns the result of a job removed on completion [${mode}]`, () => {
    test('single ACK: waitUntilFinished without QueueEvents resolves with the return value', async () => {
      harness = await CoreE2eHarness.start(mode, 'i155-wait-ack');
      const queue = harness.queue<{ secret: string }>('wait-ack');
      const manager = harness.brokerManager();
      const job = await queue.add(
        'tool',
        { secret: 'tok-A' },
        { removeOnComplete: true, attempts: 1, durable: true }
      );
      const pulled = await manager.pull(queue.name);
      expect(String(pulled?.id)).toBe(job.id);

      const wait = settledWithin(job.waitUntilFinished(null, 10_000), 8_000);
      await holdRegistered(harness, manager);
      await manager.ack(pulled!.id, { answer: 2 });

      expect(await wait).toEqual({ value: { answer: 2 } });
      expect(await queue.getJobState(job.id)).toBe('unknown');
    });

    test('batch ACK: waitUntilFinished without QueueEvents resolves with the return value', async () => {
      harness = await CoreE2eHarness.start(mode, 'i155-wait-ackb');
      const queue = harness.queue('wait-ackb');
      const manager = harness.brokerManager();
      const first = await queue.add('tool', { n: 1 }, { removeOnComplete: true, durable: true });
      const second = await queue.add('tool', { n: 2 }, { removeOnComplete: true, durable: true });
      const pulledFirst = await manager.pull(queue.name);
      const pulledSecond = await manager.pull(queue.name);
      expect([String(pulledFirst?.id), String(pulledSecond?.id)].sort()).toEqual(
        [first.id, second.id].sort()
      );

      const wait = settledWithin(second.waitUntilFinished(null, 10_000), 8_000);
      await holdRegistered(harness, manager);
      await manager.ackBatchWithResults([
        { id: jobId(first.id), result: { answer: 1 } },
        { id: jobId(second.id), result: { answer: 4 } },
      ]);

      expect(await wait).toEqual({ value: { answer: 4 } });
      expect(await queue.getJobState(second.id)).toBe('unknown');
    });
  });

  describe(`issue #155 B: job.remove() on a finished or running job [${mode}]`, () => {
    test('remove() deletes a completed job, its data and its result', async () => {
      harness = await CoreE2eHarness.start(mode, 'i155-remove-completed');
      const queue = harness.queue<{ secret: string }>('remove-completed');
      const manager = harness.brokerManager();
      const job = await queue.add('tool', { secret: 'tok-B' }, { attempts: 1, durable: true });
      const pulled = await manager.pull(queue.name);
      await manager.ack(pulled!.id, { answer: 4 });
      expect(await queue.getJobState(job.id)).toBe('completed');
      expect(await job.waitUntilFinished(null, 5_000)).toEqual({ answer: 4 });

      expect(await settledWithin(job.remove(), 5_000)).toEqual({ value: undefined });

      expect(await queue.getJob(job.id)).toBeFalsy();
      expect(await queue.getJobState(job.id)).toBe('unknown');
      expect(await manager.getJob(jobId(job.id))).toBeNull();
      expect(await manager.getCompletionAsync(jobId(job.id))).toEqual({
        found: false,
        result: undefined,
      });
      manager.flushPersistence();
      expect(sqliteRows(harness.dataPath, job.id)).toEqual({ jobs: 0, results: 0 });
    });

    test('a removed completed job stays removed after a broker restart', async () => {
      harness = await CoreE2eHarness.start(mode, 'i155-remove-restart');
      const queue = harness.queue('remove-restart');
      const name = queue.name;
      const manager = harness.brokerManager();
      const job = await queue.add('tool', { secret: 'tok-R' }, { durable: true });
      const pulled = await manager.pull(name);
      await manager.ack(pulled!.id, { answer: 8 });
      expect(await manager.cancel(jobId(job.id))).toBe(true);

      await harness.restartBroker();
      const restarted = harness.brokerManager();

      expect(await restarted.getJob(jobId(job.id))).toBeNull();
      expect(await restarted.getJobState(jobId(job.id))).toBe('unknown');
      expect(restarted.getResult(jobId(job.id))).toBeUndefined();
      expect(sqliteRows(harness.dataPath, job.id)).toEqual({ jobs: 0, results: 0 });
    });

    test('a job added later with dependsOn a removed completed job is not blocked', async () => {
      harness = await CoreE2eHarness.start(mode, 'i155-remove-dependency');
      const queue = harness.queue('remove-dependency');
      const manager = harness.brokerManager();
      const dependency = await queue.add('dep', { n: 1 }, { durable: true });
      const pulled = await manager.pull(queue.name);
      await manager.ack(pulled!.id, { answer: 1 });

      await dependency.remove();
      expect(await queue.getJobState(dependency.id)).toBe('unknown');

      // The completion proof outlives the removal, as it does for removeOnComplete.
      const dependent = await queue.add(
        'dependent',
        { n: 2 },
        { dependsOn: [dependency.id], durable: true }
      );
      expect(await queue.getJobState(dependent.id)).toBe('waiting');
    });

    test('remove() on an active job rejects and leaves the job running', async () => {
      harness = await CoreE2eHarness.start(mode, 'i155-remove-active');
      const queue = harness.queue('remove-active');
      const manager = harness.brokerManager();
      const job = await queue.add('tool', { n: 1 }, { durable: true });
      const pulled = await manager.pull(queue.name);
      expect(await queue.getJobState(job.id)).toBe('active');

      const removal = await settledWithin(job.remove(), 5_000);
      expect(removal).toHaveProperty('error');
      expect((removal as { error: string }).error).toMatch(/active/);

      expect(await queue.getJobState(job.id)).toBe('active');
      await manager.ack(pulled!.id, { answer: 3 });
      expect(await queue.getJobState(job.id)).toBe('completed');
    });

    test('remove() on a job that does not exist still resolves', async () => {
      harness = await CoreE2eHarness.start(mode, 'i155-remove-missing');
      const queue = harness.queue('remove-missing');

      expect(await settledWithin(queue.removeAsync('no-such-job'), 5_000)).toEqual({
        value: undefined,
      });
    });
  });
}
