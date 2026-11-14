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
  // Integration tests across operations
  // ============================================================

  describe('Cross-operation integration', () => {
    test('cancel then re-push same data works', async () => {
      const job = await qm.push('test-queue', { data: { msg: 'reusable' } });
      await qm.cancel(job.id);

      const newJob = await qm.push('test-queue', { data: { msg: 'reusable' } });
      expect(newJob.id).not.toBe(job.id);
      expect(qm.count('test-queue')).toBe(1);
    });

    test('drain then push new jobs works', async () => {
      await qm.push('test-queue', { data: { id: 1 } });
      await qm.push('test-queue', { data: { id: 2 } });

      qm.drain('test-queue');
      expect(qm.count('test-queue')).toBe(0);

      await qm.push('test-queue', { data: { id: 3 } });
      expect(qm.count('test-queue')).toBe(1);

      const pulled = await qm.pull('test-queue');
      expect(pulled).not.toBeNull();
      expect((pulled!.data as { id: number }).id).toBe(3);
    });

    test('pause, push, resume, pull flow', async () => {
      qm.pause('test-queue');
      await qm.push('test-queue', { data: { msg: 'queued-while-paused' } });

      // Cannot pull while paused
      const nullPull = await qm.pull('test-queue', 0);
      expect(nullPull).toBeNull();

      qm.resume('test-queue');

      // Now can pull
      const pulled = await qm.pull('test-queue', 0);
      expect(pulled).not.toBeNull();
      expect(pulled!.data).toEqual({ msg: 'queued-while-paused' });
    });

    test('promote then pull immediately', async () => {
      const delayed = await qm.push('test-queue', {
        data: { msg: 'promote-and-pull' },
        delay: 60000,
      });

      // Cannot pull delayed
      let pulled = await qm.pull('test-queue', 0);
      expect(pulled).toBeNull();

      // Promote
      await qm.promote(delayed.id);

      // Now can pull
      pulled = await qm.pull('test-queue', 0);
      expect(pulled).not.toBeNull();
      expect(pulled!.id).toBe(delayed.id);
    });

    test('change priority affects pull order among many jobs', async () => {
      const jobs = [];
      for (let i = 0; i < 5; i++) {
        jobs.push(await qm.push('test-queue', { data: { id: i }, priority: i }));
      }

      // Job 0 has lowest priority, boost it to highest
      await qm.changePriority(jobs[0].id, 100);

      const pulled = await qm.pull('test-queue');
      expect((pulled!.data as { id: number }).id).toBe(0);
    });

    test('full lifecycle: push, pull, update progress, ack, get result', async () => {
      const job = await qm.push('test-queue', { data: { msg: 'lifecycle' } });

      // State: waiting
      expect(await qm.getJobState(job.id)).toBe('waiting');

      const pulled = await qm.pull('test-queue');

      // State: active
      expect(await qm.getJobState(pulled!.id)).toBe('active');

      // Update progress
      await qm.updateProgress(pulled!.id, 50, 'processing');
      const progress = qm.getProgress(pulled!.id);
      expect(progress!.progress).toBe(50);

      // Ack
      await qm.ack(pulled!.id, { status: 'done' });

      // State: completed
      expect(await qm.getJobState(pulled!.id)).toBe('completed');

      // Get result
      const result = qm.getResult(pulled!.id);
      expect(result).toEqual({ status: 'done' });
    });

    test('discard from active then retry from DLQ', async () => {
      await qm.push('test-queue', { data: { msg: 'discard-retry' } });
      const pulled = await qm.pull('test-queue');

      // Discard to DLQ
      await qm.discard(pulled!.id);
      expect(qm.getDlq('test-queue').length).toBe(1);

      // Retry from DLQ
      const retried = qm.retryDlq('test-queue');
      expect(retried).toBe(1);

      // Job should be back in queue
      expect(qm.count('test-queue')).toBe(1);

      // Should be pullable again
      const rePulled = await qm.pull('test-queue');
      expect(rePulled).not.toBeNull();
      expect(rePulled!.data).toEqual({ msg: 'discard-retry' });
    });
  });
});
