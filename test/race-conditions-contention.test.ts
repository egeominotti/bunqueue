import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { QueueManager } from '../src/application/queueManager';
import type { JobId } from '../src/domain/types/job';
import { raceConditionsFixture } from './support/race-conditions-fixture';

describe('Race Condition Tests', () => {
  describe('5. High Concurrency Lock Contention', () => {
    let qm: QueueManager;

    const fixture = raceConditionsFixture();
    beforeEach(async () => {
      qm = await fixture.create();
    });
    afterEach(() => fixture.close());

    test('should handle 100 concurrent pulls from same queue', async () => {
      const JOBS = 100;
      const QUEUE = 'contention-pull-queue';

      // Push all jobs
      for (let i = 0; i < JOBS; i++) {
        await qm.push(QUEUE, { data: { i } });
      }

      // 100 concurrent pulls
      const pulls = Array.from({ length: JOBS }, () => qm.pull(QUEUE, 100));

      const results = await Promise.all(pulls);
      const pulledJobs = results.filter((r) => r !== null);
      const pulledIds = new Set(pulledJobs.map((j) => String(j!.id)));

      // Each job should be pulled exactly once (no duplicates)
      expect(pulledIds.size).toBe(JOBS);
      expect(pulledJobs.length).toBe(JOBS);
    });

    test('should handle concurrent acks for different jobs', async () => {
      const JOBS = 50;
      const QUEUE = 'contention-ack-queue';

      // Push and pull jobs with locks
      const jobs: Array<{ id: JobId; token?: string }> = [];
      for (let i = 0; i < JOBS; i++) {
        await qm.push(QUEUE, { data: { i } });
        const { job, token } = await qm.pullWithLock(QUEUE, `owner-${i}`, 0);
        if (job) {
          jobs.push({ id: job.id, token: token ?? undefined });
        }
      }

      // Concurrent acks
      const acks = jobs.map((job) =>
        qm.ack(job.id, { result: 'done' }, job.token).then(
          () => ({ success: true, id: job.id }),
          (e) => ({ success: false, id: job.id, error: e.message })
        )
      );

      const results = await Promise.all(acks);
      const successful = results.filter((r) => r.success);

      expect(successful.length).toBe(JOBS);

      const stats = qm.getStats();
      expect(stats.completed).toBe(JOBS);
      expect(stats.active).toBe(0);
    });

    test('should handle rapid push/pull cycles without losing jobs', async () => {
      const CYCLES = 100;
      const QUEUE = 'rapid-cycle-queue';
      const processedIds: Set<string> = new Set();
      const errors: string[] = [];

      // Rapid push/pull/ack cycles
      const cycles = Array.from({ length: CYCLES }, async (_, i) => {
        try {
          await qm.push(QUEUE, { data: { cycle: i } });
          const pulled = await qm.pull(QUEUE, 100);
          if (pulled) {
            processedIds.add(String(pulled.id));
            await qm.ack(pulled.id, { result: i });
          }
          return true;
        } catch (e) {
          errors.push(String(e));
          return false;
        }
      });

      const results = await Promise.all(cycles);
      const successCount = results.filter((r) => r).length;

      // Most cycles should succeed
      expect(successCount).toBeGreaterThan(CYCLES * 0.8);
      expect(errors.length).toBeLessThan(CYCLES * 0.2);

      // Clean up any remaining jobs
      while (true) {
        const job = await qm.pull(QUEUE, 10);
        if (!job) break;
        await qm.ack(job.id, {});
      }

      const stats = qm.getStats();
      expect(stats.waiting).toBe(0);
      expect(stats.active).toBe(0);
    });
  });
});
