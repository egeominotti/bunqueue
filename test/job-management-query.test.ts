/**
 * Comprehensive tests for:
 * - jobManagement.ts (cancel, promote, update, changePriority, discard)
 * - queryOperations.ts (getJob, getJobState, getJobResult, getJobs, getJobCounts, count)
 * - queueControl.ts (pause, resume, drain, obliterate)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import type { JobId } from '../src/domain/types/job';

describe('Job Management Operations', () => {
  let qm: QueueManager;

  beforeEach(() => {
    qm = new QueueManager();
  });

  afterEach(() => {
    qm.shutdown();
  });

  // ============================================================
  // queryOperations.ts
  // ============================================================

  describe('getJob', () => {
    test('should get a waiting job by ID', async () => {
      const pushed = await qm.push('test-queue', { data: { msg: 'find-me' } });

      const found = await qm.getJob(pushed.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(pushed.id);
      expect(found!.data).toEqual({ msg: 'find-me' });
      expect(found!.queue).toBe('test-queue');
    });

    test('should get an active job by ID', async () => {
      await qm.push('test-queue', { data: { msg: 'active-find' } });
      const pulled = await qm.pull('test-queue');

      const found = await qm.getJob(pulled!.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(pulled!.id);
      expect(found!.startedAt).not.toBeNull();
    });

    test('should return null for non-existent job', async () => {
      const found = await qm.getJob('non-existent' as JobId);
      expect(found).toBeNull();
    });

    test('should get a delayed job by ID', async () => {
      const job = await qm.push('test-queue', {
        data: { msg: 'delayed-find' },
        delay: 60000,
      });

      const found = await qm.getJob(job.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(job.id);
      expect(found!.runAt).toBeGreaterThan(Date.now());
    });
  });

  describe('getJobState', () => {
    test('should return "waiting" for a waiting job', async () => {
      const job = await qm.push('test-queue', { data: { msg: 'waiting' } });
      const state = await qm.getJobState(job.id);
      expect(state).toBe('waiting');
    });

    test('should return "delayed" for a delayed job', async () => {
      const job = await qm.push('test-queue', {
        data: { msg: 'delayed' },
        delay: 60000,
      });
      const state = await qm.getJobState(job.id);
      expect(state).toBe('delayed');
    });

    test('should return "active" for an active job', async () => {
      await qm.push('test-queue', { data: { msg: 'active' } });
      const pulled = await qm.pull('test-queue');
      const state = await qm.getJobState(pulled!.id);
      expect(state).toBe('active');
    });

    test('should return "completed" for a completed job', async () => {
      await qm.push('test-queue', { data: { msg: 'complete-me' } });
      const pulled = await qm.pull('test-queue');
      await qm.ack(pulled!.id, { done: true });

      const state = await qm.getJobState(pulled!.id);
      expect(state).toBe('completed');
    });

    test('should return "unknown" for non-existent job', async () => {
      const state = await qm.getJobState('non-existent' as JobId);
      expect(state).toBe('unknown');
    });
  });

  describe('getJobResult', () => {
    test('should get result of a completed job', async () => {
      await qm.push('test-queue', { data: { msg: 'result-test' } });
      const pulled = await qm.pull('test-queue');
      await qm.ack(pulled!.id, { result: 'success', value: 42 });

      const result = qm.getResult(pulled!.id);
      expect(result).toEqual({ result: 'success', value: 42 });
    });

    test('should return undefined for incomplete job', async () => {
      const job = await qm.push('test-queue', { data: { msg: 'no-result' } });
      const result = qm.getResult(job.id);
      expect(result).toBeUndefined();
    });

    test('should return undefined for non-existent job', async () => {
      const result = qm.getResult('non-existent' as JobId);
      expect(result).toBeUndefined();
    });
  });

  describe('getJobs (with filters and pagination)', () => {
    test('should get all waiting jobs from a queue', async () => {
      await qm.push('test-queue', { data: { id: 1 } });
      await qm.push('test-queue', { data: { id: 2 } });
      await qm.push('test-queue', { data: { id: 3 } });

      const jobs = qm.getJobs('test-queue', { state: 'waiting' });
      expect(jobs.length).toBe(3);
    });

    test('should get delayed jobs only', async () => {
      await qm.push('test-queue', { data: { id: 'immediate' } });
      await qm.push('test-queue', { data: { id: 'delayed1' }, delay: 60000 });
      await qm.push('test-queue', { data: { id: 'delayed2' }, delay: 60000 });

      const jobs = qm.getJobs('test-queue', { state: 'delayed' });
      expect(jobs.length).toBe(2);
    });

    test('should get active jobs only', async () => {
      await qm.push('test-queue', { data: { id: 'active1' } });
      await qm.push('test-queue', { data: { id: 'active2' } });
      await qm.push('test-queue', { data: { id: 'waiting' } });

      await qm.pull('test-queue');
      await qm.pull('test-queue');

      const jobs = qm.getJobs('test-queue', { state: 'active' });
      expect(jobs.length).toBe(2);
    });

    test('should support pagination with start and end', async () => {
      for (let i = 0; i < 10; i++) {
        await qm.push('test-queue', { data: { id: i } });
      }

      const page = qm.getJobs('test-queue', { state: 'waiting', start: 2, end: 5 });
      expect(page.length).toBe(3);
    });

    test('should support ascending sort order (default)', async () => {
      const job1 = await qm.push('test-queue', { data: { id: 'first' } });
      const job2 = await qm.push('test-queue', { data: { id: 'second' } });

      const jobs = qm.getJobs('test-queue', { state: 'waiting', asc: true });
      expect(jobs.length).toBe(2);
      // Ascending: older first
      expect(jobs[0].id).toBe(job1.id);
      expect(jobs[1].id).toBe(job2.id);
    });

    test('should support descending sort order', async () => {
      // Use explicit timestamps to guarantee distinct createdAt values
      const now = Date.now();
      const job1 = await qm.push('test-queue', { data: { id: 'first' }, timestamp: now - 1000 });
      const job2 = await qm.push('test-queue', { data: { id: 'second' }, timestamp: now });

      const jobsDesc = qm.getJobs('test-queue', { state: 'waiting', asc: false });
      expect(jobsDesc.length).toBe(2);
      // Descending: newer first
      expect(jobsDesc[0].id).toBe(job2.id);
      expect(jobsDesc[1].id).toBe(job1.id);
    });

    test('should return empty array for empty queue', async () => {
      const jobs = qm.getJobs('empty-queue', { state: 'waiting' });
      expect(jobs.length).toBe(0);
    });

    test('should return all states when no state filter provided', async () => {
      await qm.push('test-queue', { data: { id: 'waiting' } });
      await qm.push('test-queue', { data: { id: 'delayed' }, delay: 60000 });
      await qm.push('test-queue', { data: { id: 'to-active' } });
      await qm.pull('test-queue');

      const jobs = qm.getJobs('test-queue');
      // Should include waiting (1) + delayed (1) + active (1)
      expect(jobs.length).toBe(3);
    });
  });

  describe('getQueueJobCounts', () => {
    test('should return counts per state', async () => {
      // Add 3 waiting
      await qm.push('test-queue', { data: { id: 'w1' } });
      await qm.push('test-queue', { data: { id: 'w2' } });
      await qm.push('test-queue', { data: { id: 'w3' } });
      // Add 1 delayed
      await qm.push('test-queue', { data: { id: 'd1' }, delay: 60000 });

      // Pull one to make it active (FIFO, so w1 gets pulled)
      await qm.pull('test-queue');

      const counts = qm.getQueueJobCounts('test-queue');
      expect(counts.waiting).toBe(2); // w2 and w3 remain waiting
      expect(counts.delayed).toBe(1);
      expect(counts.active).toBe(1);
    });

    test('should return zero counts for empty queue', async () => {
      const counts = qm.getQueueJobCounts('empty-queue');
      expect(counts.waiting).toBe(0);
      expect(counts.delayed).toBe(0);
      expect(counts.active).toBe(0);
      expect(counts.failed).toBe(0);
    });

    test('should count failed jobs (DLQ)', async () => {
      await qm.push('test-queue', { data: { msg: 'fail-me' }, maxAttempts: 1 });
      const pulled = await qm.pull('test-queue');
      await qm.fail(pulled!.id, 'intentional failure');

      const counts = qm.getQueueJobCounts('test-queue');
      expect(counts.failed).toBe(1);
    });
  });

  describe('count', () => {
    test('should count jobs in a queue', async () => {
      expect(qm.count('test-queue')).toBe(0);

      await qm.push('test-queue', { data: { id: 1 } });
      expect(qm.count('test-queue')).toBe(1);

      await qm.push('test-queue', { data: { id: 2 } });
      expect(qm.count('test-queue')).toBe(2);
    });

    test('should include delayed jobs in count', async () => {
      await qm.push('test-queue', { data: { id: 1 } });
      await qm.push('test-queue', { data: { id: 2 }, delay: 60000 });

      expect(qm.count('test-queue')).toBe(2);
    });

    test('should return 0 for non-existent queue', async () => {
      expect(qm.count('non-existent')).toBe(0);
    });
  });
});
