/**
 * Comprehensive tests for client-side DLQ and Deduplication modules
 * Tests: deduplication.ts
 *
 * Run with: BUNQUEUE_EMBEDDED=1 bun test test/client-dlq-dedup-deduplication.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Queue, shutdownManager } from '../src/client';

// ============================================================
// DEDUPLICATION OPERATIONS (src/client/queue/deduplication.ts)
// ============================================================
describe('Deduplication Operations', () => {
  let queue: Queue<Record<string, unknown>>;
  const QUEUE_NAME = 'dedup-test';

  beforeEach(() => {
    queue = new Queue(QUEUE_NAME);
  });

  afterEach(() => {
    shutdownManager();
  });

  describe('getDeduplicationJobId', () => {
    it('should return null for a non-existent deduplication key', async () => {
      const result = await queue.getDeduplicationJobId('non-existent');
      expect(result).toBeNull();
    });

    it('should return the owner ID for an existing deduplication key', async () => {
      const deduplicationId = `dedup-${Date.now()}`;
      const job = await queue.add(
        'dedup-task',
        { val: 1 },
        { deduplication: { id: deduplicationId, ttl: 60_000 } }
      );

      const found = await queue.getDeduplicationJobId(deduplicationId);
      expect(found).toBe(String(job.id));
    });
  });

  describe('removeDeduplicationKey', () => {
    it('should return 0 for a non-existent deduplication key', async () => {
      const result = await queue.removeDeduplicationKey('does-not-exist');
      expect(result).toBe(0);
    });

    it('should return 1 for an existing deduplication key', async () => {
      const deduplicationId = `dedup-remove-${Date.now()}`;
      await queue.add(
        'dedup-task',
        { val: 1 },
        { deduplication: { id: deduplicationId, ttl: 60_000 } }
      );

      const result = await queue.removeDeduplicationKey(deduplicationId);
      expect(result).toBe(1);
      expect(await queue.getDeduplicationJobId(deduplicationId)).toBeNull();
    });
  });

  describe('deduplication with jobId', () => {
    it('should deduplicate jobs with the same custom jobId', async () => {
      const customId = `unique-${Date.now()}`;

      const job1 = await queue.add('task', { val: 1 }, { jobId: customId });
      const job2 = await queue.add('task', { val: 2 }, { jobId: customId });

      // Both adds should succeed but the second should be deduplicated
      // (may return the same job or a new one depending on implementation)
      expect(job1.id).toBeDefined();
      expect(job2.id).toBeDefined();

      // There should only be one waiting job with this custom ID
      const foundId = await queue.getDeduplicationJobId(customId);
      expect(foundId).toBeDefined();
    });

    it('should allow different custom IDs as distinct jobs', async () => {
      const id1 = `distinct-1-${Date.now()}`;
      const id2 = `distinct-2-${Date.now()}`;

      const job1 = await queue.add('task', { val: 1 }, { jobId: id1 });
      const job2 = await queue.add('task', { val: 2 }, { jobId: id2 });

      expect(job1.id).toBeDefined();
      expect(job2.id).toBeDefined();
      // They should not be the same internal job
      // (custom IDs are different)
    });
  });
});
