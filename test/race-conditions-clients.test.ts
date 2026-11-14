import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { QueueManager } from '../src/application/queueManager';
import type { JobId } from '../src/domain/types/job';
import { raceConditionsFixture } from './support/race-conditions-fixture';

describe('Race Condition Tests', () => {
  describe('1. Concurrent Client Disconnections (releaseClientJobs)', () => {
    let qm: QueueManager;

    const fixture = raceConditionsFixture();
    beforeEach(async () => {
      qm = await fixture.create();
    });
    afterEach(() => fixture.close());

    test('should safely release jobs when multiple clients disconnect simultaneously', async () => {
      const CLIENTS = 10;
      const JOBS_PER_CLIENT = 20;

      // Push jobs for each "client"
      const clientJobs: Map<string, JobId[]> = new Map();

      for (let c = 0; c < CLIENTS; c++) {
        const clientId = `client-${c}`;
        clientJobs.set(clientId, []);

        for (let j = 0; j < JOBS_PER_CLIENT; j++) {
          const job = await qm.push('race-queue', {
            data: { client: c, job: j },
          });
          clientJobs.get(clientId)!.push(job.id);
        }
      }

      // Pull jobs and register them with clients
      for (let c = 0; c < CLIENTS; c++) {
        const clientId = `client-${c}`;
        for (let j = 0; j < JOBS_PER_CLIENT; j++) {
          const job = await qm.pull('race-queue', 0);
          if (job) {
            qm.registerClientJob(clientId, job.id);
          }
        }
      }

      let stats = qm.getStats();
      expect(stats.active).toBe(CLIENTS * JOBS_PER_CLIENT);
      expect(stats.waiting).toBe(0);

      // Simulate all clients disconnecting simultaneously
      const releasePromises = Array.from({ length: CLIENTS }, (_, c) =>
        qm.releaseClientJobs(`client-${c}`)
      );

      const results = await Promise.all(releasePromises);

      // Each client should have released their jobs
      const totalReleased = results.reduce((a, b) => a + b, 0);
      expect(totalReleased).toBe(CLIENTS * JOBS_PER_CLIENT);

      // All jobs should be back in waiting state
      stats = qm.getStats();
      expect(stats.active).toBe(0);
      expect(stats.waiting).toBe(CLIENTS * JOBS_PER_CLIENT);

      // Verify jobs can be pulled again
      let pulledCount = 0;
      for (let i = 0; i < CLIENTS * JOBS_PER_CLIENT; i++) {
        const job = await qm.pull('race-queue', 0);
        if (job) pulledCount++;
      }
      expect(pulledCount).toBe(CLIENTS * JOBS_PER_CLIENT);
    });

    test('should handle interleaved pull and release operations', async () => {
      const ITERATIONS = 50;

      // Push initial jobs
      for (let i = 0; i < ITERATIONS; i++) {
        await qm.push('interleave-queue', { data: { i } });
      }

      const operations: Promise<any>[] = [];
      const processedJobs: Set<string> = new Set();

      // Interleave pull, ack, and release operations
      for (let i = 0; i < ITERATIONS; i++) {
        const clientId = `client-${i % 5}`;

        // Pull operation with client registration
        operations.push(
          qm.pull('interleave-queue', 50).then(async (job) => {
            if (job) {
              processedJobs.add(String(job.id));
              qm.registerClientJob(clientId, job.id);
              // Randomly ack or let release handle it
              if (Math.random() > 0.5) {
                await qm.ack(job.id, { result: 'done' });
                qm.unregisterClientJob(clientId, job.id);
                return 'acked';
              }
              return 'pulled';
            }
            return 'empty';
          })
        );

        // Occasionally release client jobs
        if (i % 10 === 9) {
          operations.push(qm.releaseClientJobs(clientId).then((count) => `released-${count}`));
        }
      }

      await Promise.all(operations);

      // Should not have lost any jobs - all should be completed, waiting, or active
      const stats = qm.getStats();
      expect(stats.waiting + stats.active + stats.completed).toBe(ITERATIONS);
    });

    test('should not duplicate jobs when releasing under contention', async () => {
      const JOBS = 100;
      const CLIENT = 'contention-client';

      // Push and pull all jobs
      for (let i = 0; i < JOBS; i++) {
        await qm.push('contention-queue', { data: { i } });
      }

      for (let i = 0; i < JOBS; i++) {
        const job = await qm.pull('contention-queue', 0);
        if (job) {
          qm.registerClientJob(CLIENT, job.id);
        }
      }

      // Try to release multiple times concurrently
      const releaseAttempts = Array.from({ length: 10 }, () => qm.releaseClientJobs(CLIENT));

      const results = await Promise.all(releaseAttempts);

      // Only the first release should have released jobs
      const totalReleased = results.reduce((a, b) => a + b, 0);
      expect(totalReleased).toBe(JOBS);

      // Exactly JOBS should be in waiting state
      const stats = qm.getStats();
      expect(stats.waiting).toBe(JOBS);
      expect(stats.active).toBe(0);
    });
  });
});
