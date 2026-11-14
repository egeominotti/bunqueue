import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { QueueManager } from '../src/application/queueManager';
import type { JobId } from '../src/domain/types/job';
import { raceConditionsFixture } from './support/race-conditions-fixture';

describe('Race Condition Tests', () => {
  describe('2. Lock Expiration Under Load (checkExpiredLocks)', () => {
    let qm: QueueManager;

    const fixture = raceConditionsFixture();
    beforeEach(async () => {
      qm = await fixture.create();
    });
    afterEach(() => fixture.close());

    test('should handle concurrent lock renewals and operations', async () => {
      const JOBS = 50;

      // Push and pull jobs using pullWithLock
      const jobs: Array<{ id: JobId; token: string }> = [];
      for (let i = 0; i < JOBS; i++) {
        await qm.push('lock-queue', { data: { i } });
        const { job, token } = await qm.pullWithLock('lock-queue', `owner-${i}`, 0);
        if (job && token) {
          jobs.push({ id: job.id, token });
        }
      }

      expect(jobs.length).toBe(JOBS);

      // Concurrent operations: some renew, some ack
      const operations: Promise<any>[] = [];

      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        if (i % 2 === 0) {
          // Renew lock using correct method name
          operations.push(
            Promise.resolve(qm.renewJobLock(job.id, job.token, 30000)).then((success) => ({
              type: 'renew',
              success,
              id: job.id,
            }))
          );
        } else {
          // Ack with token
          operations.push(
            qm.ack(job.id, { result: 'done' }, job.token).then(
              () => ({ type: 'ack', success: true, id: job.id }),
              () => ({ type: 'ack', success: false, id: job.id })
            )
          );
        }
      }

      const results = await Promise.all(operations);

      const renewed = results.filter((r) => r.type === 'renew' && r.success);
      const acked = results.filter((r) => r.type === 'ack' && r.success);

      // All operations should succeed
      expect(renewed.length + acked.length).toBe(JOBS);
    });

    test('should safely handle lock verification during concurrent operations', async () => {
      const JOB_COUNT = 30;

      // Create jobs with locks
      const jobs: Array<{ id: JobId; token: string }> = [];
      for (let i = 0; i < JOB_COUNT; i++) {
        await qm.push('verify-queue', { data: { i } });
        const { job, token } = await qm.pullWithLock('verify-queue', `owner-${i}`, 0);
        if (job && token) {
          jobs.push({ id: job.id, token });
        }
      }

      expect(jobs.length).toBe(JOB_COUNT);

      // Concurrent verify, renew, and complete operations
      const operations: Promise<any>[] = [];

      for (const job of jobs) {
        // Verify operation
        operations.push(
          Promise.resolve(qm.verifyLock(job.id, job.token)).then((valid) => ({
            type: 'verify',
            valid,
          }))
        );

        // Complete operation (with correct token)
        operations.push(
          qm.ack(job.id, {}, job.token).then(
            () => ({ type: 'ack', success: true }),
            () => ({ type: 'ack', success: false })
          )
        );
      }

      const results = await Promise.all(operations);

      // Some verify may fail because job was already acked
      // But no errors should occur (race conditions would cause exceptions)
      const ackResults = results.filter((r) => r.type === 'ack');
      const successfulAcks = ackResults.filter((r) => r.success);

      // All jobs should eventually be acked (only first ack per job succeeds)
      expect(successfulAcks.length).toBe(JOB_COUNT);
    });
  });
});
