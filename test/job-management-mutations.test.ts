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

  describe('discardJob', () => {
    test('should discard a waiting job to DLQ', async () => {
      const job = await qm.push('test-queue', { data: { msg: 'discard-me' } });

      const result = await qm.discard(job.id);
      expect(result).toBe(true);

      // Should appear in DLQ
      const dlqJobs = qm.getDlq('test-queue');
      expect(dlqJobs.length).toBe(1);
      expect(dlqJobs[0].id).toBe(job.id);
    });

    test('should discard an active job to DLQ', async () => {
      await qm.push('test-queue', { data: { msg: 'discard-active' } });
      const pulled = await qm.pull('test-queue');

      const result = await qm.discard(pulled!.id);
      expect(result).toBe(true);

      const dlqJobs = qm.getDlq('test-queue');
      expect(dlqJobs.length).toBe(1);
      expect(dlqJobs[0].id).toBe(pulled!.id);
    });

    test('should return false for non-existent job', async () => {
      const result = await qm.discard('non-existent' as JobId);
      expect(result).toBe(false);
    });

    test('should remove discarded job from queue count', async () => {
      await qm.push('test-queue', { data: { msg: 'keep' } });
      const toDiscard = await qm.push('test-queue', { data: { msg: 'discard' } });

      expect(qm.count('test-queue')).toBe(2);

      await qm.discard(toDiscard.id);

      expect(qm.count('test-queue')).toBe(1);
    });
  });

  describe('updateJobProgress', () => {
    test('should update progress of an active job', async () => {
      await qm.push('test-queue', { data: { msg: 'progress' } });
      const pulled = await qm.pull('test-queue');

      const result = await qm.updateProgress(pulled!.id, 50, 'halfway done');
      expect(result).toBe(true);

      const progress = qm.getProgress(pulled!.id);
      expect(progress).not.toBeNull();
      expect(progress!.progress).toBe(50);
      expect(progress!.message).toBe('halfway done');
    });

    test('should clamp progress to 0-100', async () => {
      await qm.push('test-queue', { data: { msg: 'clamp' } });
      const pulled = await qm.pull('test-queue');

      await qm.updateProgress(pulled!.id, 150);
      let progress = qm.getProgress(pulled!.id);
      expect(progress!.progress).toBe(100);

      await qm.updateProgress(pulled!.id, -10);
      progress = qm.getProgress(pulled!.id);
      expect(progress!.progress).toBe(0);
    });

    test('should return false for waiting job', async () => {
      const job = await qm.push('test-queue', { data: { msg: 'waiting' } });
      const result = await qm.updateProgress(job.id, 50);
      expect(result).toBe(false);
    });
  });

  describe('moveJobToDelayed', () => {
    test('should move an active job back to delayed', async () => {
      await qm.push('test-queue', { data: { msg: 'delay-me' } });
      const pulled = await qm.pull('test-queue');
      expect(pulled).not.toBeNull();

      const result = await qm.moveToDelayed(pulled!.id, 60000);
      expect(result).toBe(true);

      // Job should now be delayed
      const state = await qm.getJobState(pulled!.id);
      expect(state).toBe('delayed');
    });

    test('should move a waiting job to delayed', async () => {
      const job = await qm.push('test-queue', { data: { msg: 'delay-waiting' } });
      // In-queue (waiting/prioritized/delayed) jobs are routed through changeDelay
      // so they become delayed rather than a silent no-op (matches embedded/TCP).
      const result = await qm.moveToDelayed(job.id, 5000);
      expect(result).toBe(true);
      expect(await qm.getJobState(job.id)).toBe('delayed');
    });

    test('should return false for non-existent job', async () => {
      const result = await qm.moveToDelayed('non-existent' as JobId, 5000);
      expect(result).toBe(false);
    });
  });

  describe('getCountsPerPriority', () => {
    test('should return counts grouped by priority', async () => {
      await qm.push('test-queue', { data: { id: 1 }, priority: 1 });
      await qm.push('test-queue', { data: { id: 2 }, priority: 1 });
      await qm.push('test-queue', { data: { id: 3 }, priority: 5 });
      await qm.push('test-queue', { data: { id: 4 }, priority: 10 });

      const counts = qm.getCountsPerPriority('test-queue');
      expect(counts[1]).toBe(2);
      expect(counts[5]).toBe(1);
      expect(counts[10]).toBe(1);
    });
  });
});
