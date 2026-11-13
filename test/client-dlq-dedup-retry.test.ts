/**
 * Comprehensive tests for client-side DLQ and Deduplication modules
 * Tests: dlq.ts, dlqOps.ts (retry, retry by filter, purge, async variants)
 *
 * Run with: BUNQUEUE_EMBEDDED=1 bun test test/client-dlq-dedup-retry.test.ts
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
    shutdownManager();
  });

  // ---- retryDlq ----
  describe('retryDlq', () => {
    it('should retry all DLQ entries and return count', async () => {
      await addAndFailJob(queue, QUEUE_NAME, { retry: 1 });
      await addAndFailJob(queue, QUEUE_NAME, { retry: 2 });

      const entriesBefore = queue.getDlq();
      expect(entriesBefore.length).toBeGreaterThanOrEqual(2);

      const retried = queue.retryDlq();
      expect(retried).toBeGreaterThanOrEqual(2);

      // DLQ should be empty after retry
      const entriesAfter = queue.getDlq();
      expect(entriesAfter.length).toBe(0);
    });

    it('should retry a single DLQ entry by ID', async () => {
      const jobId = await addAndFailJob(queue, QUEUE_NAME, { single: true });

      const entriesBefore = queue.getDlq();
      const entry = entriesBefore.find((e) => e.job.id === jobId);
      expect(entry).toBeDefined();

      const retried = queue.retryDlq(jobId);
      expect(retried).toBe(1);

      // That specific entry should be gone
      const entriesAfter = queue.getDlq();
      const stillThere = entriesAfter.find((e) => e.job.id === jobId);
      expect(stillThere).toBeUndefined();
    });

    it('should return 0 when retrying a non-existent job ID', () => {
      const retried = queue.retryDlq('non-existent-id');
      expect(retried).toBe(0);
    });

    it('should move retried jobs back to waiting state', async () => {
      const jobId = await addAndFailJob(queue, QUEUE_NAME, { retryCheck: 1 });

      queue.retryDlq(jobId);

      // The job should now be waiting (or active if picked up fast)
      const state = await queue.getJobState(jobId);
      expect(['waiting', 'active', 'delayed']).toContain(state);
    });
  });

  // ---- retryDlqByFilter ----
  describe('retryDlqByFilter', () => {
    it('should retry DLQ entries matching a filter', async () => {
      await addAndFailJob(queue, QUEUE_NAME, { filterRetry: 1 });

      const retried = queue.retryDlqByFilter({ reason: 'max_attempts_exceeded' });
      expect(retried).toBeGreaterThanOrEqual(1);
    });

    it('should return 0 when filter matches nothing', () => {
      const retried = queue.retryDlqByFilter({ reason: 'stalled' });
      expect(retried).toBe(0);
    });

    it('should retry with limit filter', async () => {
      await addAndFailJob(queue, QUEUE_NAME, { limitRetry: 1 });
      await addAndFailJob(queue, QUEUE_NAME, { limitRetry: 2 });
      await addAndFailJob(queue, QUEUE_NAME, { limitRetry: 3 });

      const retried = queue.retryDlqByFilter({
        reason: 'max_attempts_exceeded',
        limit: 1,
      });
      expect(retried).toBeLessThanOrEqual(1);
    });
  });

  // ---- purgeDlq ----
  describe('purgeDlq', () => {
    it('should purge all DLQ entries and return count', async () => {
      await addAndFailJob(queue, QUEUE_NAME, { purge: 1 });
      await addAndFailJob(queue, QUEUE_NAME, { purge: 2 });

      const beforeCount = queue.getDlq().length;
      expect(beforeCount).toBeGreaterThanOrEqual(2);

      const purged = queue.purgeDlq();
      expect(purged).toBeGreaterThanOrEqual(2);

      const afterCount = queue.getDlq().length;
      expect(afterCount).toBe(0);
    });

    it('should return 0 when purging an empty DLQ', () => {
      const purged = queue.purgeDlq();
      expect(purged).toBe(0);
    });
  });

  // ---- async variants (awaitable, return the server count over TCP too) ----
  describe('retryDlqAsync / purgeDlqAsync', () => {
    it('retryDlqAsync should retry all entries and resolve with the count', async () => {
      await addAndFailJob(queue, QUEUE_NAME, { asyncRetry: 1 });
      await addAndFailJob(queue, QUEUE_NAME, { asyncRetry: 2 });

      const retried = await queue.retryDlqAsync();
      expect(retried).toBeGreaterThanOrEqual(2);
      expect(queue.getDlq().length).toBe(0);
    });

    it('purgeDlqAsync should purge and resolve with the count', async () => {
      await addAndFailJob(queue, QUEUE_NAME, { asyncPurge: 1 });

      const purged = await queue.purgeDlqAsync();
      expect(purged).toBeGreaterThanOrEqual(1);
      expect(queue.getDlq().length).toBe(0);
    });

    it('both resolve with 0 on an empty DLQ', async () => {
      expect(await queue.retryDlqAsync()).toBe(0);
      expect(await queue.purgeDlqAsync()).toBe(0);
    });

    it('retryDlqAsync(id) retries only the requested entry', async () => {
      const first = await addAndFailJob(queue, QUEUE_NAME, { pick: 1 });
      await addAndFailJob(queue, QUEUE_NAME, { pick: 2 });

      const retried = await queue.retryDlqAsync(first);
      expect(retried).toBe(1);

      const remaining = queue.getDlq();
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.job.id).not.toBe(first);
    });

    it('retryDlqAsync with an unknown id resolves with 0', async () => {
      await addAndFailJob(queue, QUEUE_NAME, { keep: true });
      expect(await queue.retryDlqAsync('no-such-job-id')).toBe(0);
      expect(queue.getDlq().length).toBe(1);
    });
  });
});
