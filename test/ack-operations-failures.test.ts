/**
 * Ack/Fail Operations Tests
 * Comprehensive tests for ack.ts and ackHelpers.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { jobId, type JobId } from '../src/domain/types/job';

describe('Ack Operations', () => {
  let qm: QueueManager;

  beforeEach(() => {
    qm = new QueueManager();
  });

  afterEach(() => {
    qm.shutdown();
  });

  // ============ Fail Operations ============

  describe('failJob', () => {
    test('should increment attempts count', async () => {
      await qm.push('test-q', { data: { msg: 'hello' }, maxAttempts: 3 });
      const pulled = await qm.pull('test-q');
      expect(pulled!.attempts).toBe(0);

      await qm.fail(pulled!.id, 'Error');

      // Job should be requeued with incremented attempts
      // We need to wait for the backoff period, so check stats
      const stats = qm.getStats();
      expect(stats.waiting + stats.delayed).toBe(1);
    });

    test('should requeue job when retries remain', async () => {
      await qm.push('test-q', { data: { msg: 'hello' }, maxAttempts: 3 });
      const pulled = await qm.pull('test-q');

      await qm.fail(pulled!.id, 'Transient error');

      const stats = qm.getStats();
      expect(stats.active).toBe(0);
      // Job should be requeued (waiting or delayed due to backoff)
      expect(stats.waiting + stats.delayed).toBe(1);
      expect(stats.dlq).toBe(0);
    });

    test('should move to DLQ when max attempts exceeded', async () => {
      await qm.push('test-q', { data: { msg: 'hello' }, maxAttempts: 1 });
      const pulled = await qm.pull('test-q');

      await qm.fail(pulled!.id, 'Final error');

      const stats = qm.getStats();
      expect(stats.dlq).toBe(1);
      expect(stats.active).toBe(0);
    });

    test('should store error message in DLQ entry', async () => {
      await qm.push('test-q', { data: { msg: 'hello' }, maxAttempts: 1 });
      const pulled = await qm.pull('test-q');

      await qm.fail(pulled!.id, 'Specific error message');

      const dlqJobs = qm.getDlq('test-q');
      expect(dlqJobs.length).toBe(1);
    });

    test('should move to DLQ after exhausting all retries', async () => {
      await qm.push('test-q', {
        data: { msg: 'hello' },
        maxAttempts: 2,
        backoff: 0, // No backoff delay for faster testing
      });

      // First attempt
      let pulled = await qm.pull('test-q');
      await qm.fail(pulled!.id, 'Error 1');

      // Second attempt (job requeued with attempts=1, pull it again)
      pulled = await qm.pull('test-q');
      expect(pulled).not.toBeNull();
      await qm.fail(pulled!.id, 'Error 2');

      const stats = qm.getStats();
      expect(stats.dlq).toBe(1);
      expect(stats.waiting + stats.delayed).toBe(0);
    });

    test('should throw when failing non-existent job', async () => {
      const fakeId = jobId('00000000-0000-7000-8000-000000000099');
      await expect(qm.fail(fakeId, 'Error')).rejects.toThrow(
        /Job not found or not in processing state/
      );
    });

    test('should throw when failing already failed job', async () => {
      await qm.push('test-q', { data: { msg: 'hello' }, maxAttempts: 1 });
      const pulled = await qm.pull('test-q');

      await qm.fail(pulled!.id, 'Error');

      // Failing again should throw since job moved out of processing
      await expect(qm.fail(pulled!.id, 'Error again')).rejects.toThrow(
        /Job not found or not in processing state/
      );
    });

    test('should handle fail with undefined error message', async () => {
      await qm.push('test-q', { data: { msg: 'hello' }, maxAttempts: 1 });
      const pulled = await qm.pull('test-q');

      await qm.fail(pulled!.id, undefined);

      const stats = qm.getStats();
      expect(stats.dlq).toBe(1);
    });

    test('should increment totalFailed counter when moved to DLQ', async () => {
      await qm.push('test-q', { data: { msg: 'hello' }, maxAttempts: 1 });
      const pulled = await qm.pull('test-q');

      await qm.fail(pulled!.id, 'Error');

      const stats = qm.getStats();
      expect(Number(stats.totalFailed)).toBe(1);
    });

    test('should not increment totalFailed when job is retried', async () => {
      await qm.push('test-q', { data: { msg: 'hello' }, maxAttempts: 3 });
      const pulled = await qm.pull('test-q');

      await qm.fail(pulled!.id, 'Retriable error');

      const stats = qm.getStats();
      expect(Number(stats.totalFailed)).toBe(0);
    });
  });

  // ============ Fail with removeOnFail ============

  describe('failJob with removeOnFail', () => {
    test('should remove job entirely when removeOnFail is true and max attempts exceeded', async () => {
      await qm.push('test-q', {
        data: { msg: 'hello' },
        maxAttempts: 1,
        removeOnFail: true,
      });
      const pulled = await qm.pull('test-q');

      await qm.fail(pulled!.id, 'Error');

      // Job should be completely gone, not in DLQ
      const job = await qm.getJob(pulled!.id);
      expect(job).toBeNull();

      const stats = qm.getStats();
      expect(stats.dlq).toBe(0);
    });

    test('should still retry when removeOnFail is true but retries remain', async () => {
      await qm.push('test-q', {
        data: { msg: 'hello' },
        maxAttempts: 3,
        removeOnFail: true,
      });
      const pulled = await qm.pull('test-q');

      await qm.fail(pulled!.id, 'Retriable error');

      const stats = qm.getStats();
      // Job should be requeued, not removed
      expect(stats.waiting + stats.delayed).toBe(1);
      expect(stats.dlq).toBe(0);
    });

    test('should release customId when removeOnFail removes the job', async () => {
      await qm.push('test-q', {
        data: { msg: 'first' },
        customId: 'my-custom-id',
        maxAttempts: 1,
        removeOnFail: true,
      });
      const pulled = await qm.pull('test-q');
      // customId is used as the job ID
      expect(pulled!.id).toBe('my-custom-id' as JobId);
      await qm.fail(pulled!.id, 'Error');

      // Job should be completely gone (removeOnFail + max attempts exceeded)
      const job = await qm.getJob(pulled!.id);
      expect(job).toBeNull();

      const state = await qm.getJobState(pulled!.id);
      expect(state).toBe('unknown');

      // The customId mapping should have been cleaned up
      const stats = qm.getStats();
      expect(stats.dlq).toBe(0); // Not in DLQ because removeOnFail=true
    });
  });

  // ============ Fail with backoff ============

  describe('failJob with backoff', () => {
    test('should apply exponential backoff on retry', async () => {
      await qm.push('test-q', {
        data: { msg: 'hello' },
        maxAttempts: 3,
        backoff: 1000,
      });
      const pulled = await qm.pull('test-q');

      await qm.fail(pulled!.id, 'Error');

      // Job should be delayed (not immediately available)
      const stats = qm.getStats();
      expect(stats.delayed).toBeGreaterThanOrEqual(1);
    });
  });

  // ============ Lock-based Ack ============

  describe('ack with lock tokens', () => {
    test('should ack successfully with valid lock token', async () => {
      await qm.push('test-q', { data: { msg: 'hello' } });
      const { job, token } = await qm.pullWithLock('test-q', 'worker-1');
      expect(job).not.toBeNull();
      expect(token).not.toBeNull();

      await qm.ack(job!.id, { done: true }, token!);

      const stats = qm.getStats();
      expect(stats.completed).toBe(1);
    });

    test('should throw with invalid lock token', async () => {
      await qm.push('test-q', { data: { msg: 'hello' } });
      const { job } = await qm.pullWithLock('test-q', 'worker-1');
      expect(job).not.toBeNull();

      await expect(qm.ack(job!.id, { done: true }, 'invalid-token-abc')).rejects.toThrow(
        /Invalid or expired lock token/
      );
    });

    test('should fail with valid lock token', async () => {
      await qm.push('test-q', { data: { msg: 'hello' }, maxAttempts: 1 });
      const { job, token } = await qm.pullWithLock('test-q', 'worker-1');

      await qm.fail(job!.id, 'Error', token!);

      const stats = qm.getStats();
      expect(stats.dlq).toBe(1);
    });

    test('should throw fail with invalid lock token', async () => {
      await qm.push('test-q', { data: { msg: 'hello' }, maxAttempts: 1 });
      const { job } = await qm.pullWithLock('test-q', 'worker-1');

      await expect(qm.fail(job!.id, 'Error', 'invalid-token-xyz')).rejects.toThrow(
        /Invalid or expired lock token/
      );
    });

    test('should ack without token when no lock was acquired', async () => {
      await qm.push('test-q', { data: { msg: 'hello' } });
      const pulled = await qm.pull('test-q');

      // Ack without token should work since no lock was set
      await qm.ack(pulled!.id);

      const stats = qm.getStats();
      expect(stats.completed).toBe(1);
    });
  });
});
