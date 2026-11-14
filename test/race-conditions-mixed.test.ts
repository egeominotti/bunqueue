import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { QueueManager } from '../src/application/queueManager';
import { raceConditionsFixture } from './support/race-conditions-fixture';

describe('Race Condition Tests', () => {
  describe('4. Mixed Concurrent Operations Stress Test', () => {
    let qm: QueueManager;

    const fixture = raceConditionsFixture();
    beforeEach(async () => {
      qm = await fixture.create();
    });
    afterEach(() => fixture.close());

    test('should handle push/pull/ack/fail/release all concurrently', async () => {
      const OPERATIONS = 200;
      const QUEUES = ['stress-a', 'stress-b', 'stress-c'];
      const errors: Error[] = [];

      const operations: Promise<any>[] = [];

      for (let i = 0; i < OPERATIONS; i++) {
        const queue = QUEUES[i % QUEUES.length];
        const clientId = `client-${i % 10}`;
        const op = i % 5;

        switch (op) {
          case 0:
            // Push
            operations.push(
              qm.push(queue, { data: { i } }).catch((e) => {
                errors.push(e);
                return null;
              })
            );
            break;

          case 1:
            // Pull and register
            operations.push(
              qm
                .pull(queue, 10)
                .then((job) => {
                  if (job) {
                    qm.registerClientJob(clientId, job.id);
                  }
                  return job;
                })
                .catch((e) => {
                  errors.push(e);
                  return null;
                })
            );
            break;

          case 2:
            // Ack random job
            operations.push(
              qm.pull(queue, 0).then(async (job) => {
                if (job) {
                  try {
                    await qm.ack(job.id, { result: i });
                  } catch {
                    // Job might have been released/processed already
                  }
                }
              })
            );
            break;

          case 3:
            // Fail random job
            operations.push(
              qm.pull(queue, 0).then(async (job) => {
                if (job) {
                  try {
                    await qm.fail(job.id, `Error ${i}`);
                  } catch {
                    // Job might have been released/processed already
                  }
                }
              })
            );
            break;

          case 4:
            // Release client jobs
            operations.push(
              qm.releaseClientJobs(clientId).catch((e) => {
                errors.push(e);
                return 0;
              })
            );
            break;
        }
      }

      await Promise.all(operations);

      // Should have no race condition errors
      expect(errors.length).toBe(0);

      // Stats should be consistent
      const stats = qm.getStats();
      expect(stats.waiting).toBeGreaterThanOrEqual(0);
      expect(stats.active).toBeGreaterThanOrEqual(0);
      expect(stats.completed).toBeGreaterThanOrEqual(0);
    });
  });
});
