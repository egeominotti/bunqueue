/** Issue #155 through the public Queue/Worker request/reply APIs. */
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { jobId } from '../src/domain/types/job';
import { CoreE2eHarness } from './core-e2e/support/harness';

setDefaultTimeout(30_000);

let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function storedRows(path: string, id: string): { jobs: number; results: number } {
  const db = new Database(path, { readonly: true });
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
  describe(`issue #155 request/reply with a real Worker [${mode}]`, () => {
    test('self-cleaning requests return every result and explicit removal forgets it', async () => {
      harness = await CoreE2eHarness.start(mode, 'i155-public-roc');
      const h = harness;
      const queue = h.queue<{ secret: string; index: number }>('public-roc');
      const results: unknown[] = [{ answer: 2 }, null, false, 0, undefined];
      h.worker<{ secret: string; index: number }, unknown>(
        queue.name,
        (job) => results[job.data.index],
        { concurrency: 1 }
      );
      const manager = h.brokerManager();

      for (let index = 0; index < results.length; index++) {
        const job = await queue.add(
          'tool',
          { secret: `tok-${index}`, index },
          { removeOnComplete: true, attempts: 1, durable: true }
        );

        expect(await job.waitUntilFinished(null, 10_000)).toEqual(results[index]);
        expect(await queue.getJob(job.id)).toBeFalsy();
        expect(await queue.getJobState(job.id)).toBe('unknown');
        manager.flushPersistence();
        expect(storedRows(h.dataPath, job.id)).toEqual({ jobs: 0, results: 0 });
        expect(await manager.getCompletionAsync(jobId(job.id))).toEqual({
          found: true,
          result: results[index],
        });

        // Once read, the caller can also discard the short-lived, memory-only result.
        await job.remove();
        expect(await manager.getCompletionAsync(jobId(job.id))).toEqual({
          found: false,
          result: undefined,
        });
      }
    });

    test('reading then removing a retained request deletes its payload and result durably', async () => {
      harness = await CoreE2eHarness.start(mode, 'i155-public-remove');
      const h = harness;
      const queue = h.queue<{ secret: string; n: number }>('public-remove');
      const worker = h.worker<{ secret: string; n: number }, { answer: number }>(
        queue.name,
        (job) => ({ answer: job.data.n * 2 }),
        { concurrency: 1 }
      );
      const job = await queue.add(
        'tool',
        { secret: 'tok-retained', n: 2 },
        { removeOnComplete: false, attempts: 1, durable: true }
      );

      expect(await job.waitUntilFinished(null, 10_000)).toEqual({ answer: 4 });
      expect((await queue.getJob(job.id))?.data).toEqual({ secret: 'tok-retained', n: 2 });
      expect(await queue.getJobState(job.id)).toBe('completed');

      await job.remove();

      const manager = h.brokerManager();
      manager.flushPersistence();
      expect(await queue.getJob(job.id)).toBeFalsy();
      expect(await queue.getJobState(job.id)).toBe('unknown');
      expect(await manager.getCompletionAsync(jobId(job.id))).toEqual({
        found: false,
        result: undefined,
      });
      expect(manager.getResult(jobId(job.id))).toBeUndefined();
      expect(storedRows(h.dataPath, job.id)).toEqual({ jobs: 0, results: 0 });

      await worker.close(true);
      await h.restartBroker();
      const restarted = h.brokerManager();
      expect(await restarted.getJob(jobId(job.id))).toBeNull();
      expect(await restarted.getJobState(jobId(job.id))).toBe('unknown');
      expect(await restarted.getCompletionAsync(jobId(job.id))).toEqual({
        found: false,
        result: undefined,
      });
      expect(restarted.getResult(jobId(job.id))).toBeUndefined();
      expect(storedRows(h.dataPath, job.id)).toEqual({ jobs: 0, results: 0 });
    });
  });
}
