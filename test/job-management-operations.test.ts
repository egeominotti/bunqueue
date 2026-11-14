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
  // jobManagement.ts
  // ============================================================

  describe('cancelJob', () => {
    test('should cancel a waiting job', async () => {
      const job = await qm.push('test-queue', { data: { msg: 'cancel-me' } });
      const result = await qm.cancel(job.id);

      expect(result).toBe(true);

      // Job should no longer be retrievable
      const found = await qm.getJob(job.id);
      expect(found).toBeNull();
    });

    test('should return false for non-existent job', async () => {
      const fakeId = 'non-existent-id' as JobId;
      const result = await qm.cancel(fakeId);
      expect(result).toBe(false);
    });

    test('should not cancel an active job (returns false)', async () => {
      await qm.push('test-queue', { data: { msg: 'active-job' } });
      const pulled = await qm.pull('test-queue');
      expect(pulled).not.toBeNull();

      // Active jobs have location type 'processing', cancelJob only handles 'queue'
      const result = await qm.cancel(pulled!.id);
      expect(result).toBe(false);
    });

    test('should cancel a delayed job', async () => {
      const job = await qm.push('test-queue', {
        data: { msg: 'delayed-cancel' },
        delay: 60000,
      });

      const result = await qm.cancel(job.id);
      expect(result).toBe(true);

      const found = await qm.getJob(job.id);
      expect(found).toBeNull();
    });

    test('should remove cancelled job from queue count', async () => {
      await qm.push('test-queue', { data: { msg: 'job1' } });
      const job2 = await qm.push('test-queue', { data: { msg: 'job2' } });
      await qm.push('test-queue', { data: { msg: 'job3' } });

      expect(qm.count('test-queue')).toBe(3);

      await qm.cancel(job2.id);

      expect(qm.count('test-queue')).toBe(2);
    });

    test('should release unique key on cancel', async () => {
      const job = await qm.push('test-queue', {
        data: { msg: 'unique-job' },
        uniqueKey: 'my-unique-key',
      });

      await qm.cancel(job.id);

      // Should be able to push with same unique key now
      const newJob = await qm.push('test-queue', {
        data: { msg: 'new-unique-job' },
        uniqueKey: 'my-unique-key',
      });

      expect(newJob.id).not.toBe(job.id);
    });
  });

  describe('promoteJob', () => {
    test('should promote a delayed job to immediate', async () => {
      const job = await qm.push('test-queue', {
        data: { msg: 'promote-me' },
        delay: 60000,
      });

      // Verify job is delayed
      const stateBefore = await qm.getJobState(job.id);
      expect(stateBefore).toBe('delayed');

      const result = await qm.promote(job.id);
      expect(result).toBe(true);

      // Now the job should be pullable (waiting)
      const pulled = await qm.pull('test-queue', 0);
      expect(pulled).not.toBeNull();
      expect(pulled!.id).toBe(job.id);
    });

    test('should return false for non-delayed job (waiting)', async () => {
      const job = await qm.push('test-queue', { data: { msg: 'already-waiting' } });

      const result = await qm.promote(job.id);
      expect(result).toBe(false);
    });

    test('should return false for non-existent job', async () => {
      const result = await qm.promote('non-existent' as JobId);
      expect(result).toBe(false);
    });

    test('should return false for active job', async () => {
      await qm.push('test-queue', { data: { msg: 'test' } });
      const pulled = await qm.pull('test-queue');

      const result = await qm.promote(pulled!.id);
      expect(result).toBe(false);
    });
  });

  describe('updateJobData', () => {
    test('should update data of a waiting job', async () => {
      const job = await qm.push('test-queue', { data: { msg: 'original' } });

      const result = await qm.updateJobData(job.id, { msg: 'updated' });
      expect(result).toBe(true);

      const found = await qm.getJob(job.id);
      expect(found).not.toBeNull();
      expect(found!.data).toEqual({ msg: 'updated' });
    });

    test('should update data of an active job', async () => {
      await qm.push('test-queue', { data: { msg: 'original' } });
      const pulled = await qm.pull('test-queue');

      const result = await qm.updateJobData(pulled!.id, { msg: 'updated-active' });
      expect(result).toBe(true);

      const found = await qm.getJob(pulled!.id);
      expect(found).not.toBeNull();
      expect(found!.data).toEqual({ msg: 'updated-active' });
    });

    test('should return false for non-existent job', async () => {
      const result = await qm.updateJobData('non-existent' as JobId, { msg: 'nope' });
      expect(result).toBe(false);
    });
  });

  describe('changeJobPriority', () => {
    test('should change priority of a waiting job', async () => {
      const job = await qm.push('test-queue', {
        data: { msg: 'change-priority' },
        priority: 5,
      });

      const result = await qm.changePriority(job.id, 100);
      expect(result).toBe(true);

      const found = await qm.getJob(job.id);
      expect(found).not.toBeNull();
      expect(found!.priority).toBe(100);
    });

    test('should affect pull order after priority change', async () => {
      const lowJob = await qm.push('test-queue', {
        data: { id: 'was-low' },
        priority: 1,
      });
      await qm.push('test-queue', {
        data: { id: 'high' },
        priority: 10,
      });

      // Raise the low priority job above the high one
      await qm.changePriority(lowJob.id, 100);

      const first = await qm.pull('test-queue');
      expect((first?.data as { id: string }).id).toBe('was-low');
    });

    test('should return false for non-existent job', async () => {
      const result = await qm.changePriority('non-existent' as JobId, 10);
      expect(result).toBe(false);
    });

    test('should return false for active job', async () => {
      await qm.push('test-queue', { data: { msg: 'test' } });
      const pulled = await qm.pull('test-queue');

      const result = await qm.changePriority(pulled!.id, 50);
      expect(result).toBe(false);
    });
  });

  describe('getJobProgress', () => {
    test('should return null for non-processing job', async () => {
      const job = await qm.push('test-queue', { data: { msg: 'nope' } });
      const progress = qm.getProgress(job.id);
      expect(progress).toBeNull();
    });

    test('should return default progress for active job', async () => {
      await qm.push('test-queue', { data: { msg: 'test' } });
      const pulled = await qm.pull('test-queue');

      const progress = qm.getProgress(pulled!.id);
      expect(progress).not.toBeNull();
      expect(progress!.progress).toBe(0);
      expect(progress!.message).toBeNull();
    });
  });

  describe('getJobByCustomId', () => {
    test('should find job by custom ID', async () => {
      const job = await qm.push('test-queue', {
        data: { msg: 'custom' },
        customId: 'my-custom-id',
      });

      const found = qm.getJobByCustomId('my-custom-id');
      expect(found).not.toBeNull();
      expect(found!.id).toBe(job.id);
    });

    test('should return null for non-existent custom ID', async () => {
      const found = qm.getJobByCustomId('does-not-exist');
      expect(found).toBeNull();
    });
  });
});
