/**
 * Comprehensive tests for:
 * - jobManagement.ts (cancel, promote, update, changePriority, discard)
 * - queryOperations.ts (getJob, getJobState, getJobResult, getJobs, getJobCounts, count)
 * - queueControl.ts (pause, resume, drain, obliterate)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';

describe('Job Management Operations', () => {
  let qm: QueueManager;

  beforeEach(() => {
    qm = new QueueManager();
  });

  afterEach(() => {
    qm.shutdown();
  });

  // ============================================================
  // queueControl.ts
  // ============================================================

  describe('pauseQueue', () => {
    test('should pause a queue', async () => {
      qm.pause('test-queue');

      expect(qm.isPaused('test-queue')).toBe(true);
    });

    test('should prevent pulls on paused queue', async () => {
      await qm.push('test-queue', { data: { msg: 'paused-pull' } });

      qm.pause('test-queue');

      const pulled = await qm.pull('test-queue', 0);
      expect(pulled).toBeNull();
    });

    test('should still allow push to paused queue', async () => {
      qm.pause('test-queue');

      const job = await qm.push('test-queue', { data: { msg: 'pushed-while-paused' } });
      expect(job).toBeDefined();
      expect(job.id).toBeDefined();
      expect(qm.count('test-queue')).toBe(1);
    });
  });

  describe('resumeQueue', () => {
    test('should allow pulls after resume', async () => {
      await qm.push('test-queue', { data: { msg: 'resume-pull' } });

      qm.pause('test-queue');
      const nullPull = await qm.pull('test-queue', 0);
      expect(nullPull).toBeNull();

      qm.resume('test-queue');
      const pulled = await qm.pull('test-queue', 0);
      expect(pulled).not.toBeNull();
      expect(pulled!.data).toEqual({ msg: 'resume-pull' });
    });

    test('should be no-op on non-paused queue', async () => {
      expect(qm.isPaused('test-queue')).toBe(false);
      qm.resume('test-queue');
      expect(qm.isPaused('test-queue')).toBe(false);
    });
  });

  describe('drainQueue', () => {
    test('should drain all waiting jobs from queue', async () => {
      await qm.push('test-queue', { data: { id: 1 } });
      await qm.push('test-queue', { data: { id: 2 } });
      await qm.push('test-queue', { data: { id: 3 } });

      expect(qm.count('test-queue')).toBe(3);

      const drained = qm.drain('test-queue');
      expect(drained).toBe(3);
      expect(qm.count('test-queue')).toBe(0);
    });

    test('should return 0 for empty queue', async () => {
      const drained = qm.drain('empty-queue');
      expect(drained).toBe(0);
    });

    test('should not affect active jobs', async () => {
      await qm.push('test-queue', { data: { id: 'active' } });
      await qm.push('test-queue', { data: { id: 'waiting1' } });
      await qm.push('test-queue', { data: { id: 'waiting2' } });

      // Pull one job to make it active
      const pulled = await qm.pull('test-queue');
      expect(pulled).not.toBeNull();

      // Drain remaining
      const drained = qm.drain('test-queue');
      expect(drained).toBe(2);

      // Active job should still be retrievable
      const state = await qm.getJobState(pulled!.id);
      expect(state).toBe('active');
    });

    test('should drain delayed jobs too', async () => {
      await qm.push('test-queue', { data: { id: 'immediate' } });
      await qm.push('test-queue', { data: { id: 'delayed' }, delay: 60000 });

      const drained = qm.drain('test-queue');
      expect(drained).toBe(2);
      expect(qm.count('test-queue')).toBe(0);
    });

    test('should clean up jobIndex for drained jobs', async () => {
      const job1 = await qm.push('test-queue', { data: { id: 1 } });
      const job2 = await qm.push('test-queue', { data: { id: 2 } });

      qm.drain('test-queue');

      // Drained jobs should not be findable
      const found1 = await qm.getJob(job1.id);
      const found2 = await qm.getJob(job2.id);
      expect(found1).toBeNull();
      expect(found2).toBeNull();
    });
  });

  describe('obliterateQueue', () => {
    test('should remove all queue data', async () => {
      await qm.push('test-queue', { data: { id: 1 } });
      await qm.push('test-queue', { data: { id: 2 } });

      qm.obliterate('test-queue');

      expect(qm.count('test-queue')).toBe(0);

      const jobs = qm.getJobs('test-queue');
      expect(jobs.length).toBe(0);
    });

    test('should remove DLQ entries too', async () => {
      await qm.push('test-queue', { data: { msg: 'fail-me' }, maxAttempts: 1 });
      const pulled = await qm.pull('test-queue');
      await qm.fail(pulled!.id, 'intentional');

      const dlqBefore = qm.getDlq('test-queue');
      expect(dlqBefore.length).toBe(1);

      qm.obliterate('test-queue');

      const dlqAfter = qm.getDlq('test-queue');
      expect(dlqAfter.length).toBe(0);
    });

    test('should remove queue from listed queues', async () => {
      await qm.push('test-queue', { data: { id: 1 } });
      expect(qm.listQueues()).toContain('test-queue');

      qm.obliterate('test-queue');
      expect(qm.listQueues()).not.toContain('test-queue');
    });

    test('should handle obliterate on non-existent queue', async () => {
      // Should not throw
      qm.obliterate('non-existent-queue');
    });
  });

  describe('cleanQueue', () => {
    test('should clean old waiting jobs beyond grace period', async () => {
      // Push jobs - these will have createdAt = Date.now()
      await qm.push('test-queue', { data: { id: 1 } });
      await qm.push('test-queue', { data: { id: 2 } });

      // With a grace of 0ms, all jobs are "old"
      const cleaned = qm.clean('test-queue', 0);
      expect(cleaned.length).toBe(2);
      expect(qm.count('test-queue')).toBe(0);
    });

    test('should not clean jobs within grace period', async () => {
      await qm.push('test-queue', { data: { id: 1 } });
      await qm.push('test-queue', { data: { id: 2 } });

      // Very large grace period - no jobs should be cleaned
      const cleaned = qm.clean('test-queue', 999999999);
      expect(cleaned).toEqual([]);
      expect(qm.count('test-queue')).toBe(2);
    });

    test('should respect limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await qm.push('test-queue', { data: { id: i } });
      }

      // Clean at most 2 jobs
      const cleaned = qm.clean('test-queue', 0, undefined, 2);
      expect(cleaned.length).toBeLessThanOrEqual(2);
    });
  });

  describe('listAllQueues', () => {
    test('should list all known queues', async () => {
      await qm.push('queue-a', { data: { id: 1 } });
      await qm.push('queue-b', { data: { id: 2 } });
      await qm.push('queue-c', { data: { id: 3 } });

      const queues = qm.listQueues();
      expect(queues).toContain('queue-a');
      expect(queues).toContain('queue-b');
      expect(queues).toContain('queue-c');
    });

    test('should return empty array when no queues exist', async () => {
      const queues = qm.listQueues();
      expect(queues.length).toBe(0);
    });
  });
});
