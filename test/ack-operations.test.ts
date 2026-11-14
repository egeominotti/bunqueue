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

  // ============ Basic Ack ============

  describe('ackJob', () => {
    test('should transition job to completed state', async () => {
      await qm.push('test-q', { data: { msg: 'hello' } });
      const pulled = await qm.pull('test-q');
      expect(pulled).not.toBeNull();

      await qm.ack(pulled!.id);

      const stats = qm.getStats();
      expect(stats.completed).toBe(1);
      expect(stats.active).toBe(0);
    });

    test('should store result data when provided', async () => {
      await qm.push('test-q', { data: { msg: 'hello' } });
      const pulled = await qm.pull('test-q');

      const resultData = { processed: true, output: 42 };
      await qm.ack(pulled!.id, resultData);

      const result = qm.getResult(pulled!.id);
      expect(result).toEqual(resultData);
    });

    test('should not store result when result is undefined', async () => {
      await qm.push('test-q', { data: { msg: 'hello' } });
      const pulled = await qm.pull('test-q');

      await qm.ack(pulled!.id, undefined);

      const result = qm.getResult(pulled!.id);
      expect(result).toBeUndefined();
    });

    test('should remove job from active/processing state', async () => {
      await qm.push('test-q', { data: { msg: 'hello' } });
      const pulled = await qm.pull('test-q');

      // Before ack: job is active
      let stats = qm.getStats();
      expect(stats.active).toBe(1);

      await qm.ack(pulled!.id);

      // After ack: no longer active
      stats = qm.getStats();
      expect(stats.active).toBe(0);
    });

    test('should increment totalCompleted counter', async () => {
      await qm.push('test-q', { data: { id: 1 } });
      await qm.push('test-q', { data: { id: 2 } });
      const p1 = await qm.pull('test-q');
      const p2 = await qm.pull('test-q');

      await qm.ack(p1!.id);
      await qm.ack(p2!.id);

      const stats = qm.getStats();
      expect(stats.completed).toBe(2);
      expect(Number(stats.totalCompleted)).toBe(2);
    });

    test('should add job to completedJobs set', async () => {
      await qm.push('test-q', { data: { msg: 'hello' } });
      const pulled = await qm.pull('test-q');

      await qm.ack(pulled!.id);

      const state = await qm.getJobState(pulled!.id);
      expect(state).toBe('completed');
    });

    test('should throw when acking non-existent job', async () => {
      const fakeId = jobId('00000000-0000-7000-8000-000000000099');
      await expect(qm.ack(fakeId)).rejects.toThrow(/Job not found or not in processing state/);
    });

    test('should throw when acking already completed job', async () => {
      await qm.push('test-q', { data: { msg: 'hello' } });
      const pulled = await qm.pull('test-q');

      await qm.ack(pulled!.id);

      // Acking again should throw because job is no longer in processing
      await expect(qm.ack(pulled!.id)).rejects.toThrow(/Job not found or not in processing state/);
    });
  });

  // ============ Ack with removeOnComplete ============

  describe('ackJob with removeOnComplete', () => {
    test('should remove job entirely when removeOnComplete is true', async () => {
      await qm.push('test-q', {
        data: { msg: 'hello' },
        removeOnComplete: true,
      });
      const pulled = await qm.pull('test-q');

      await qm.ack(pulled!.id);

      // Job should be completely gone
      const job = await qm.getJob(pulled!.id);
      expect(job).toBeNull();

      const state = await qm.getJobState(pulled!.id);
      expect(state).toBe('unknown');
    });

    test('should not add to completedJobs when removeOnComplete is true', async () => {
      await qm.push('test-q', {
        data: { msg: 'hello' },
        removeOnComplete: true,
      });
      const pulled = await qm.pull('test-q');

      await qm.ack(pulled!.id, { result: 'data' });

      // Result should not be stored
      const result = qm.getResult(pulled!.id);
      expect(result).toBeUndefined();
    });

    test('should keep job in completed state when removeOnComplete is false', async () => {
      await qm.push('test-q', {
        data: { msg: 'hello' },
        removeOnComplete: false,
      });
      const pulled = await qm.pull('test-q');

      await qm.ack(pulled!.id);

      const state = await qm.getJobState(pulled!.id);
      expect(state).toBe('completed');
    });
  });

  // ============ Ack with customId ============

  describe('ackJob with customId', () => {
    test('should release customId mapping on completion', async () => {
      // customId is used as the actual job ID (jobId(input.customId))
      // After ack, the customIdMap entry is deleted
      await qm.push('test-q', {
        data: { msg: 'first' },
        customId: 'unique-job-1',
      });
      const pulled = await qm.pull('test-q');
      // The job ID should be the customId value
      expect(pulled!.id).toBe('unique-job-1' as JobId);

      await qm.ack(pulled!.id);

      // After ack, the job is in completed state
      const state = await qm.getJobState(pulled!.id);
      expect(state).toBe('completed');
    });

    test('should allow reuse of customId after ack with removeOnComplete', async () => {
      await qm.push('test-q', {
        data: { msg: 'first' },
        customId: 'reusable-id',
        removeOnComplete: true,
      });
      const pulled = await qm.pull('test-q');
      await qm.ack(pulled!.id);

      // With removeOnComplete, the job and its jobIndex entry are fully cleaned up
      // So a new push with the same customId should create a new job
      const newJob = await qm.push('test-q', {
        data: { msg: 'second' },
        customId: 'reusable-id',
      });
      expect(newJob).toBeDefined();
      expect(newJob.data).toEqual({ msg: 'second' });
    });
  });

  // ============ Ack with repeat ============

  describe('ackJob with repeat', () => {
    test('should trigger repeat when repeat config is set and limit not reached', async () => {
      await qm.push('test-q', {
        data: { msg: 'repeating' },
        repeat: { every: 1000, limit: 3 },
      });
      const pulled = await qm.pull('test-q');

      await qm.ack(pulled!.id);

      // After ack, the repeat mechanism should have added a new job
      const stats = qm.getStats();
      expect(stats.completed).toBe(1);
      // The repeatable job should have been requeued
      expect(stats.waiting + stats.delayed).toBeGreaterThanOrEqual(1);
    });
  });

  // ============ Event emission ============

  describe('ack event emission', () => {
    test('should broadcast completed event on ack', async () => {
      const events: Array<{ eventType: string; jobId: string; data?: unknown }> = [];
      qm.subscribe((event) => {
        if (event.eventType === 'completed') {
          events.push({
            eventType: event.eventType,
            jobId: event.jobId,
            data: event.data,
          });
        }
      });

      await qm.push('test-q', { data: { msg: 'hello' } });
      const pulled = await qm.pull('test-q');
      await qm.ack(pulled!.id, { success: true });

      expect(events.length).toBe(1);
      expect(events[0].eventType).toBe('completed');
      expect(events[0].jobId).toBe(pulled!.id);
      expect(events[0].data).toEqual({ success: true });
    });

    test('should broadcast failed event on fail', async () => {
      const events: Array<{ eventType: string; jobId: string; error?: string }> = [];
      qm.subscribe((event) => {
        if (event.eventType === 'failed') {
          events.push({
            eventType: event.eventType,
            jobId: event.jobId,
            error: event.error,
          });
        }
      });

      await qm.push('test-q', { data: { msg: 'hello' }, maxAttempts: 1 });
      const pulled = await qm.pull('test-q');
      await qm.fail(pulled!.id, 'Something broke');

      expect(events.length).toBe(1);
      expect(events[0].eventType).toBe('failed');
      expect(events[0].jobId).toBe(pulled!.id);
      expect(events[0].error).toBe('Something broke');
    });

    test('should broadcast retried event when job is requeued for retry', async () => {
      const events: Array<{ eventType: string; jobId: string; prev?: string }> = [];
      qm.subscribe((event) => {
        if (event.eventType === 'retried') {
          events.push({
            eventType: event.eventType,
            jobId: event.jobId,
            prev: event.prev,
          });
        }
      });

      await qm.push('test-q', { data: { msg: 'hello' }, maxAttempts: 3 });
      const pulled = await qm.pull('test-q');
      await qm.fail(pulled!.id, 'Temporary error');

      expect(events.length).toBe(1);
      expect(events[0].eventType).toBe('retried');
      expect(events[0].prev).toBe('failed');
    });
  });
});
