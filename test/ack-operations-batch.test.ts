/**
 * Ack/Fail Operations Tests
 * Comprehensive tests for ack.ts and ackHelpers.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import type { JobId } from '../src/domain/types/job';

describe('Ack Operations', () => {
  let qm: QueueManager;

  beforeEach(() => {
    qm = new QueueManager();
  });

  afterEach(() => {
    qm.shutdown();
  });

  // ============ Batch Ack ============

  describe('ackJobBatch', () => {
    test('should ack empty batch without error', async () => {
      await qm.ackBatch([]);
      // No error means success
    });

    test('should ack small batch (<=4 jobs, uses parallel individual acks)', async () => {
      const ids: JobId[] = [];
      for (let i = 0; i < 3; i++) {
        await qm.push('test-q', { data: { id: i } });
      }
      for (let i = 0; i < 3; i++) {
        const pulled = await qm.pull('test-q');
        ids.push(pulled!.id);
      }

      await qm.ackBatch(ids);

      const stats = qm.getStats();
      expect(stats.completed).toBe(3);
      expect(stats.active).toBe(0);
    });

    test('should ack large batch (>4 jobs, uses optimized path)', async () => {
      const ids: JobId[] = [];
      for (let i = 0; i < 8; i++) {
        await qm.push('test-q', { data: { id: i } });
      }
      for (let i = 0; i < 8; i++) {
        const pulled = await qm.pull('test-q');
        ids.push(pulled!.id);
      }

      await qm.ackBatch(ids);

      const stats = qm.getStats();
      expect(stats.completed).toBe(8);
      expect(stats.active).toBe(0);
    });

    test('should ack batch from multiple queues', async () => {
      const ids: JobId[] = [];
      for (let i = 0; i < 6; i++) {
        const qName = `queue-${i % 3}`;
        await qm.push(qName, { data: { id: i } });
      }
      for (let i = 0; i < 6; i++) {
        const qName = `queue-${i % 3}`;
        const pulled = await qm.pull(qName);
        ids.push(pulled!.id);
      }

      await qm.ackBatch(ids);

      const stats = qm.getStats();
      expect(stats.completed).toBe(6);
      expect(stats.active).toBe(0);
    });

    test('should handle batch with lock tokens', async () => {
      const ids: JobId[] = [];
      const tokens: string[] = [];
      for (let i = 0; i < 3; i++) {
        await qm.push('test-q', { data: { id: i } });
      }
      for (let i = 0; i < 3; i++) {
        const { job, token } = await qm.pullWithLock('test-q', 'worker-1');
        ids.push(job!.id);
        tokens.push(token!);
      }

      await qm.ackBatch(ids, tokens);

      const stats = qm.getStats();
      expect(stats.completed).toBe(3);
    });

    test('should throw batch ack with invalid lock token', async () => {
      const ids: JobId[] = [];
      const tokens: string[] = [];
      for (let i = 0; i < 2; i++) {
        await qm.push('test-q', { data: { id: i } });
      }
      for (let i = 0; i < 2; i++) {
        const { job } = await qm.pullWithLock('test-q', 'worker-1');
        ids.push(job!.id);
        tokens.push('invalid-token');
      }

      await expect(qm.ackBatch(ids, tokens)).rejects.toThrow(/Invalid or expired lock token/);
    });
  });

  // ============ Batch Ack with Results ============

  describe('ackJobBatchWithResults', () => {
    test('should ack batch with individual results (small batch)', async () => {
      const items: Array<{ id: JobId; result: unknown }> = [];
      for (let i = 0; i < 3; i++) {
        await qm.push('test-q', { data: { id: i } });
      }
      for (let i = 0; i < 3; i++) {
        const pulled = await qm.pull('test-q');
        items.push({ id: pulled!.id, result: { value: i * 10 } });
      }

      await qm.ackBatchWithResults(items);

      const stats = qm.getStats();
      expect(stats.completed).toBe(3);

      // Verify results stored correctly
      for (const item of items) {
        const result = qm.getResult(item.id);
        expect(result).toEqual(item.result);
      }
    });

    test('should ack batch with individual results (large batch)', async () => {
      const items: Array<{ id: JobId; result: unknown }> = [];
      for (let i = 0; i < 8; i++) {
        await qm.push('test-q', { data: { id: i } });
      }
      for (let i = 0; i < 8; i++) {
        const pulled = await qm.pull('test-q');
        items.push({ id: pulled!.id, result: { processed: true, index: i } });
      }

      await qm.ackBatchWithResults(items);

      const stats = qm.getStats();
      expect(stats.completed).toBe(8);

      // Verify each result
      for (const item of items) {
        const result = qm.getResult(item.id);
        expect(result).toEqual(item.result);
      }
    });

    test('should handle empty batch with results', async () => {
      await qm.ackBatchWithResults([]);
      // No error means success
    });

    test('should handle batch with lock tokens and results', async () => {
      const items: Array<{ id: JobId; result: unknown; token?: string }> = [];
      for (let i = 0; i < 3; i++) {
        await qm.push('test-q', { data: { id: i } });
      }
      for (let i = 0; i < 3; i++) {
        const { job, token } = await qm.pullWithLock('test-q', 'worker-1');
        items.push({ id: job!.id, result: { v: i }, token: token! });
      }

      await qm.ackBatchWithResults(items);

      const stats = qm.getStats();
      expect(stats.completed).toBe(3);
    });
  });

  // ============ Batch with removeOnComplete ============

  describe('batch ack with removeOnComplete', () => {
    test('should remove jobs with removeOnComplete in batch', async () => {
      const ids: JobId[] = [];
      for (let i = 0; i < 6; i++) {
        await qm.push('test-q', {
          data: { id: i },
          removeOnComplete: true,
        });
      }
      for (let i = 0; i < 6; i++) {
        const pulled = await qm.pull('test-q');
        ids.push(pulled!.id);
      }

      await qm.ackBatch(ids);

      // All jobs should be gone
      for (const id of ids) {
        const job = await qm.getJob(id);
        expect(job).toBeNull();
      }
    });

    test('should handle mixed removeOnComplete in batch', async () => {
      // Push jobs with different removeOnComplete settings
      await qm.push('test-q', {
        data: { id: 'keep' },
        removeOnComplete: false,
      });
      await qm.push('test-q', {
        data: { id: 'remove' },
        removeOnComplete: true,
      });

      const p1 = await qm.pull('test-q');
      const p2 = await qm.pull('test-q');

      await qm.ack(p1!.id);
      await qm.ack(p2!.id);

      // stats.completed only counts jobs in the completedJobs set
      // removeOnComplete=true jobs are NOT added to completedJobs
      // So only 1 of the 2 jobs is counted as completed
      const stats = qm.getStats();
      expect(stats.completed).toBe(1);
      // But totalCompleted counter includes both
      expect(Number(stats.totalCompleted)).toBe(2);
    });
  });
});
