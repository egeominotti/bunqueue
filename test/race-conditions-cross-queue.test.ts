import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { QueueManager } from '../src/application/queueManager';
import { raceConditionsFixture } from './support/race-conditions-fixture';

describe('Race Condition Tests', () => {
  describe('6. Cross-Queue Concurrent Operations', () => {
    let qm: QueueManager;

    const fixture = raceConditionsFixture();
    beforeEach(async () => {
      qm = await fixture.create();
    });
    afterEach(() => fixture.close());

    test('should handle operations across 10 queues simultaneously', async () => {
      const QUEUES = Array.from({ length: 10 }, (_, i) => `multi-queue-${i}`);
      const JOBS_PER_QUEUE = 20;

      // Push to all queues concurrently
      const pushPromises: Promise<any>[] = [];
      for (const queue of QUEUES) {
        for (let j = 0; j < JOBS_PER_QUEUE; j++) {
          pushPromises.push(qm.push(queue, { data: { queue, job: j } }));
        }
      }
      await Promise.all(pushPromises);

      let stats = qm.getStats();
      expect(stats.waiting).toBe(QUEUES.length * JOBS_PER_QUEUE);

      // Pull and ack from all queues concurrently
      const processPromises: Promise<boolean>[] = [];
      for (const queue of QUEUES) {
        for (let j = 0; j < JOBS_PER_QUEUE; j++) {
          processPromises.push(
            qm.pull(queue, 100).then(async (job) => {
              if (job) {
                await qm.ack(job.id, { result: 'done' });
                return true;
              }
              return false;
            })
          );
        }
      }

      const results = await Promise.all(processPromises);
      const processed = results.filter((r) => r).length;

      expect(processed).toBe(QUEUES.length * JOBS_PER_QUEUE);

      stats = qm.getStats();
      expect(stats.completed).toBe(QUEUES.length * JOBS_PER_QUEUE);
      expect(stats.waiting).toBe(0);
      expect(stats.active).toBe(0);
    });

    test('should handle drain during active processing', async () => {
      const QUEUE = 'drain-test-queue';
      const JOBS = 50;

      // Push jobs
      for (let i = 0; i < JOBS; i++) {
        await qm.push(QUEUE, { data: { i } });
      }

      // Start pulling (but don't ack)
      const pullPromises = Array.from({ length: 10 }, () => qm.pull(QUEUE, 0));
      await Promise.all(pullPromises);

      let stats = qm.getStats();
      expect(stats.active).toBe(10);
      expect(stats.waiting).toBe(40);

      // Drain remaining waiting jobs
      qm.drain(QUEUE);

      stats = qm.getStats();
      expect(stats.waiting).toBe(0);
      expect(stats.active).toBe(10); // Active jobs not affected by drain
    });
  });
});
