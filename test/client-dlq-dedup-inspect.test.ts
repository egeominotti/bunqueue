/**
 * Comprehensive tests for client-side DLQ and Deduplication modules
 * Tests: dlq.ts, dlqOps.ts (entries, stats, filters, getDlqJobsAsync, isolation)
 *
 * Run with: BUNQUEUE_EMBEDDED=1 bun test test/client-dlq-dedup-inspect.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Queue, shutdownManager } from '../src/client';
import { addAndFailJob } from './support/client-dlq';

// ============================================================
// DLQ OPERATIONS (src/client/queue/dlq.ts, dlqOps.ts)
// ============================================================
describe('DLQ Operations', () => {
  let queue: Queue<Record<string, unknown>>;
  const QUEUE_NAME = 'dlq-test';

  beforeEach(() => {
    queue = new Queue(QUEUE_NAME);
  });

  afterEach(() => {
    queue.close();
    shutdownManager();
  });

  // ---- Adding jobs to DLQ via failure ----
  describe('getDlq (after job failures)', () => {
    it('should contain a job after it exhausts all attempts', async () => {
      const jobId = await addAndFailJob(queue, QUEUE_NAME, { key: 'value1' });

      const entries = queue.getDlq();
      expect(entries.length).toBeGreaterThanOrEqual(1);

      const entry = entries.find((e) => e.job.id === jobId);
      expect(entry).toBeDefined();
      expect(entry!.reason).toBe('max_attempts_exceeded');
      expect(entry!.job.data).toEqual({ key: 'value1' });
    });

    it('should have correct DLQ entry metadata', async () => {
      const jobId = await addAndFailJob(queue, QUEUE_NAME, { meta: 'test' });

      const entries = queue.getDlq();
      const entry = entries.find((e) => e.job.id === jobId);
      expect(entry).toBeDefined();
      expect(entry!.enteredAt).toBeGreaterThan(0);
      expect(entry!.retryCount).toBe(0);
      expect(entry!.lastRetryAt).toBeNull();
      expect(entry!.attempts).toBeDefined();
      expect(entry!.attempts.length).toBeGreaterThanOrEqual(1);
    });

    it('should accumulate multiple failed jobs in DLQ', async () => {
      await addAndFailJob(queue, QUEUE_NAME, { idx: 1 });
      await addAndFailJob(queue, QUEUE_NAME, { idx: 2 });
      await addAndFailJob(queue, QUEUE_NAME, { idx: 3 });

      const entries = queue.getDlq();
      expect(entries.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ---- getDlqStats ----
  describe('getDlqStats', () => {
    it('should return correct stats after adding jobs to DLQ', async () => {
      await addAndFailJob(queue, QUEUE_NAME, { stat: 1 });
      await addAndFailJob(queue, QUEUE_NAME, { stat: 2 });

      const stats = queue.getDlqStats();
      expect(stats.total).toBeGreaterThanOrEqual(2);
      expect(stats.oldestEntry).toBeGreaterThan(0);
      expect(stats.newestEntry).toBeGreaterThanOrEqual(stats.oldestEntry!);
    });

    it('should track entries by reason', async () => {
      await addAndFailJob(queue, QUEUE_NAME, { reason: 'test' });

      const stats = queue.getDlqStats();
      expect(stats.byReason).toBeDefined();
      expect(stats.byReason['max_attempts_exceeded']).toBeGreaterThanOrEqual(1);
    });
  });

  // ---- DLQ Filtering ----
  describe('getDlq with filter', () => {
    it('should filter by reason', async () => {
      await addAndFailJob(queue, QUEUE_NAME, { filter: 'byReason' });

      const filtered = queue.getDlq({ reason: 'max_attempts_exceeded' });
      expect(filtered.length).toBeGreaterThanOrEqual(1);
      for (const entry of filtered) {
        expect(entry.reason).toBe('max_attempts_exceeded');
      }
    });

    it('should filter with limit', async () => {
      const first = await addAndFailJob(queue, QUEUE_NAME, { a: 1 });
      const second = await addAndFailJob(queue, QUEUE_NAME, { a: 2 });
      const third = await addAndFailJob(queue, QUEUE_NAME, { a: 3 });
      expect(queue.getDlqStats().total).toBe(3);
      expect(queue.getDlq().map((entry) => entry.job.id)).toEqual([first, second, third]);
      expect(queue.getDlq({ limit: 1 }).map((entry) => entry.job.id)).toEqual([first]);
      expect(queue.getDlq({ limit: 2 }).map((entry) => entry.job.id)).toEqual([first, second]);
    });

    it('should filter with offset', async () => {
      const first = await addAndFailJob(queue, QUEUE_NAME, { b: 1 });
      const second = await addAndFailJob(queue, QUEUE_NAME, { b: 2 });
      const third = await addAndFailJob(queue, QUEUE_NAME, { b: 3 });
      expect(queue.getDlqStats().total).toBe(3);
      expect(queue.getDlq().map((entry) => entry.job.id)).toEqual([first, second, third]);
      expect(queue.getDlq({ offset: 1 }).map((entry) => entry.job.id)).toEqual([second, third]);
      expect(queue.getDlq({ offset: 1, limit: 1 }).map((entry) => entry.job.id)).toEqual([second]);
      expect(queue.getDlq({ offset: 2, limit: 2 }).map((entry) => entry.job.id)).toEqual([third]);
      expect(queue.getDlq({ offset: 3 }).map((entry) => entry.job.id)).toEqual([]);
    });

    it('should return empty when filter matches nothing', () => {
      const filtered = queue.getDlq({ reason: 'stalled' });
      expect(filtered).toEqual([]);
    });
  });

  describe('getDlqJobsAsync', () => {
    it('returns the dead jobs as public Job objects', async () => {
      const deadId = await addAndFailJob(queue, QUEUE_NAME, { dead: true });

      const jobs = await queue.getDlqJobsAsync();
      expect(jobs.length).toBeGreaterThanOrEqual(1);

      const dead = jobs.find((j) => j.id === deadId);
      expect(dead).toBeDefined();
      expect(dead!.data).toMatchObject({ dead: true });
      expect(dead!.queueName).toBe(QUEUE_NAME);
    });

    it('honours the count cap and returns [] on an empty DLQ', async () => {
      expect(await queue.getDlqJobsAsync()).toEqual([]);

      await addAndFailJob(queue, QUEUE_NAME, { n: 1 });
      await addAndFailJob(queue, QUEUE_NAME, { n: 2 });
      expect((await queue.getDlqJobsAsync(1)).length).toBe(1);
    });
  });

  // ---- DLQ isolation between queues ----
  describe('DLQ isolation', () => {
    it('should isolate DLQ entries between different queues', async () => {
      const queue2 = new Queue<Record<string, unknown>>('dlq-test-2');

      await addAndFailJob(queue, QUEUE_NAME, { q1: true });
      await addAndFailJob(queue2, 'dlq-test-2', { q2: true });

      const entries1 = queue.getDlq();
      const entries2 = queue2.getDlq();

      // Each queue should have its own DLQ entries
      expect(entries1.length).toBeGreaterThanOrEqual(1);
      expect(entries2.length).toBeGreaterThanOrEqual(1);

      // Purge queue1 should not affect queue2
      queue.purgeDlq();
      expect(queue.getDlq().length).toBe(0);
      expect(queue2.getDlq().length).toBeGreaterThanOrEqual(1);

      queue2.purgeDlq();
    });
  });
});
