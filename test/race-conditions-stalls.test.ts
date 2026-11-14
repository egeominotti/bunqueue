import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { QueueManager } from '../src/application/queueManager';
import type { JobId } from '../src/domain/types/job';
import { shardIndex } from '../src/shared/hash';
import { raceConditionsFixture } from './support/race-conditions-fixture';

describe('Race Condition Tests', () => {
  describe('3. Stall Detection Under Concurrent Load', () => {
    let qm: QueueManager;

    const fixture = raceConditionsFixture({ stallCheckMs: 100 });
    beforeEach(async () => {
      qm = await fixture.create();
    });
    afterEach(() => fixture.close());

    test('should handle concurrent lock renewals without losing jobs', async () => {
      const JOBS = 20;
      const QUEUE = 'heartbeat-queue';

      // Configure stall detection via shard
      const shard = qm.getShards()[shardIndex(QUEUE)];
      shard.setStallConfig(QUEUE, {
        enabled: true,
        stallInterval: 200,
        maxStalls: 3,
        gracePeriod: 50,
      });

      // Push and pull jobs with locks
      const jobs: Array<{ id: JobId; token: string }> = [];
      for (let i = 0; i < JOBS; i++) {
        await qm.push(QUEUE, { data: { i } });
        const { job, token } = await qm.pullWithLock(QUEUE, `owner-${i}`, 0);
        if (job && token) {
          jobs.push({ id: job.id, token });
        }
      }

      // Concurrent lock renewals (simulates heartbeats)
      for (let round = 0; round < 5; round++) {
        const renewPromises = jobs.map((job) =>
          Promise.resolve(qm.renewJobLock(job.id, job.token, 30000))
        );
        await Promise.all(renewPromises);
        await Bun.sleep(50);
      }

      // All jobs should still be active (lock renewals prevent stall)
      const stats = qm.getStats();
      expect(stats.active).toBe(JOBS);

      // Complete all jobs
      for (const job of jobs) {
        await qm.ack(job.id, { result: 'done' }, job.token);
      }

      const finalStats = qm.getStats();
      expect(finalStats.completed).toBe(JOBS);
      expect(finalStats.active).toBe(0);
    });

    test('should not lose jobs during stall detection and recovery', async () => {
      const JOBS = 15;
      const QUEUE = 'stall-recovery-queue';

      // Configure stall detection with longer intervals for reliable testing
      const shard = qm.getShards()[shardIndex(QUEUE)];
      shard.setStallConfig(QUEUE, {
        enabled: true,
        stallInterval: 50,
        maxStalls: 5, // Higher to avoid DLQ during test
        gracePeriod: 10,
      });

      // Push jobs with high max attempts
      for (let i = 0; i < JOBS; i++) {
        await qm.push(QUEUE, {
          data: { i },
          maxAttempts: 10,
        });
      }

      // Pull all jobs with locks
      const pulledJobs: Array<{ id: JobId; token: string }> = [];
      for (let i = 0; i < JOBS; i++) {
        const { job, token } = await qm.pullWithLock(QUEUE, `owner-${i}`, 0);
        if (job && token) pulledJobs.push({ id: job.id, token });
      }
      expect(pulledJobs.length).toBe(JOBS);

      // Complete some jobs
      const toComplete = Math.floor(JOBS / 3);
      for (let i = 0; i < toComplete; i++) {
        await qm.ack(pulledJobs[i].id, { result: 'done' }, pulledJobs[i].token);
      }

      // Check that completed jobs are accounted for
      let stats = qm.getStats();
      expect(stats.completed).toBe(toComplete);

      // Complete remaining jobs
      for (let i = toComplete; i < JOBS; i++) {
        try {
          await qm.ack(pulledJobs[i].id, { result: 'done' }, pulledJobs[i].token);
        } catch {
          // Job might have been stalled and requeued, try to pull and complete
        }
      }

      // Pull and complete any remaining jobs
      let iterations = 0;
      while (iterations < 50) {
        const { job, token } = await qm.pullWithLock(QUEUE, 'cleanup', 50);
        if (!job) break;
        await qm.ack(job.id, { result: 'recovered' }, token!);
        iterations++;
      }

      const finalStats = qm.getStats();
      // All jobs should be completed or in DLQ
      expect(finalStats.waiting).toBe(0);
      expect(finalStats.active).toBe(0);
      expect(finalStats.completed + finalStats.dlq).toBe(JOBS);
    });
  });
});
