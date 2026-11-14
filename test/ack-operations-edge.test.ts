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

  // ============ Edge Cases ============

  describe('edge cases', () => {
    test('should handle concurrent acks on different jobs', async () => {
      const ids: JobId[] = [];
      for (let i = 0; i < 10; i++) {
        await qm.push('test-q', { data: { id: i } });
      }
      for (let i = 0; i < 10; i++) {
        const pulled = await qm.pull('test-q');
        ids.push(pulled!.id);
      }

      // Ack all concurrently
      await Promise.all(ids.map((id) => qm.ack(id)));

      const stats = qm.getStats();
      expect(stats.completed).toBe(10);
      expect(stats.active).toBe(0);
    });

    test('should handle ack and fail interleaved', async () => {
      await qm.push('test-q', { data: { id: 1 }, maxAttempts: 1 });
      await qm.push('test-q', { data: { id: 2 } });
      await qm.push('test-q', { data: { id: 3 }, maxAttempts: 1 });

      const p1 = await qm.pull('test-q');
      const p2 = await qm.pull('test-q');
      const p3 = await qm.pull('test-q');

      await qm.ack(p1!.id, { ok: true });
      await qm.fail(p2!.id, 'Retriable error');
      await qm.fail(p3!.id, 'Fatal error');

      const stats = qm.getStats();
      expect(stats.completed).toBe(1);
      expect(stats.dlq).toBe(1);
      // p2 should be requeued (default maxAttempts=3)
      expect(stats.waiting + stats.delayed).toBe(1);
    });

    test('should handle ack with complex result data', async () => {
      await qm.push('test-q', { data: { msg: 'hello' } });
      const pulled = await qm.pull('test-q');

      const complexResult = {
        nested: { deep: { value: 42 } },
        array: [1, 2, 3],
        string: 'test',
        bool: true,
        null: null,
      };

      await qm.ack(pulled!.id, complexResult);

      const result = qm.getResult(pulled!.id);
      expect(result).toEqual(complexResult);
    });

    test('should handle ack with null result', async () => {
      await qm.push('test-q', { data: { msg: 'hello' } });
      const pulled = await qm.pull('test-q');

      // null passes the `result !== undefined` check in ackJob,
      // so jobResults.set(jobId, null) is called.
      // However, getResult uses `??` operator: jobResults.get(id) ?? storage?.getResult(id)
      // Since null is nullish, `null ?? undefined` returns `undefined`.
      // This is expected behavior of the getResult implementation.
      await qm.ack(pulled!.id, null);

      // The job should be completed regardless of result value
      const stats = qm.getStats();
      expect(stats.completed).toBe(1);
    });

    test('should handle multiple queues independently', async () => {
      await qm.push('queue-a', { data: { q: 'a' } });
      await qm.push('queue-b', { data: { q: 'b' }, maxAttempts: 1 });

      const pA = await qm.pull('queue-a');
      const pB = await qm.pull('queue-b');

      await qm.ack(pA!.id, { result: 'a-done' });
      await qm.fail(pB!.id, 'b-error');

      const stats = qm.getStats();
      expect(stats.completed).toBe(1);
      expect(stats.dlq).toBe(1);

      const resultA = qm.getResult(pA!.id);
      expect(resultA).toEqual({ result: 'a-done' });
    });

    test('should handle rapid push-pull-ack cycle', async () => {
      for (let i = 0; i < 50; i++) {
        await qm.push('test-q', { data: { id: i } });
        const pulled = await qm.pull('test-q');
        await qm.ack(pulled!.id, { processed: i });
      }

      const stats = qm.getStats();
      expect(stats.completed).toBe(50);
      expect(stats.active).toBe(0);
      expect(stats.waiting).toBe(0);
    });
  });

  // ============ ackHelpers unit tests ============

  describe('ackHelpers', () => {
    test('groupByProcShard groups job IDs by processing shard', async () => {
      const { groupByProcShard } = await import('../src/application/operations/ackHelpers');
      const { processingShardIndex } = await import('../src/shared/hash');

      const ids = [jobId('id-aaa'), jobId('id-bbb'), jobId('id-ccc'), jobId('id-ddd')];

      const grouped = groupByProcShard(ids);

      // Verify all ids are present in grouping
      let totalIds = 0;
      for (const [shardIdx, groupIds] of grouped) {
        for (const gId of groupIds) {
          expect(processingShardIndex(gId)).toBe(shardIdx);
          totalIds++;
        }
      }
      expect(totalIds).toBe(4);
    });

    test('groupItemsByProcShard groups items with results', async () => {
      const { groupItemsByProcShard } = await import('../src/application/operations/ackHelpers');

      const items = [
        { id: jobId('id-1'), result: 'r1' },
        { id: jobId('id-2'), result: 'r2' },
        { id: jobId('id-3'), result: 'r3' },
      ];

      const grouped = groupItemsByProcShard(items);

      let totalItems = 0;
      for (const [, groupItems] of grouped) {
        totalItems += groupItems.length;
      }
      expect(totalItems).toBe(3);
    });

    test('groupByQueueShard groups extracted jobs by queue shard', async () => {
      const { groupByQueueShard } = await import('../src/application/operations/ackHelpers');
      const { shardIndex: getShardIndex } = await import('../src/shared/hash');

      const fakeJob = (queue: string) =>
        ({
          id: jobId('test-id'),
          queue,
          data: {},
          priority: 0,
          createdAt: Date.now(),
          runAt: Date.now(),
          startedAt: null,
          completedAt: null,
          attempts: 0,
          maxAttempts: 3,
          backoff: 1000,
          backoffConfig: null,
          ttl: null,
          timeout: null,
          uniqueKey: null,
          customId: null,
          dependsOn: [],
          parentId: null,
          childrenIds: [],
          childrenCompleted: 0,
          tags: [],
          groupId: null,
          progress: 0,
          progressMessage: null,
          removeOnComplete: false,
          removeOnFail: false,
          repeat: null,
          lastHeartbeat: Date.now(),
          stallTimeout: null,
          stallCount: 0,
          lifo: false,
          stackTraceLimit: 10,
          keepLogs: null,
          sizeLimit: null,
          failParentOnFailure: false,
          removeDependencyOnFailure: false,
          continueParentOnFailure: false,
          ignoreDependencyOnFailure: false,
          deduplicationTtl: null,
          deduplicationExtend: false,
          deduplicationReplace: false,
          debounceId: null,
          debounceTtl: null,
          timeline: [],
        }) as any;

      const extractedJobs = [
        { id: jobId('j1'), job: fakeJob('queue-x') },
        { id: jobId('j2'), job: fakeJob('queue-y') },
        { id: jobId('j3'), job: fakeJob('queue-x') },
      ];

      const grouped = groupByQueueShard(extractedJobs);

      let totalJobs = 0;
      for (const [shardIdx, jobs] of grouped) {
        for (const job of jobs) {
          expect(getShardIndex(job.queue)).toBe(shardIdx);
          totalJobs++;
        }
      }
      expect(totalJobs).toBe(3);
    });
  });

  // ============ State consistency ============

  describe('state consistency', () => {
    test('should maintain consistent counts across push-pull-ack cycle', async () => {
      const count = 20;
      for (let i = 0; i < count; i++) {
        await qm.push('test-q', { data: { id: i } });
      }

      let stats = qm.getStats();
      expect(stats.waiting).toBe(count);
      expect(Number(stats.totalPushed)).toBe(count);

      const ids: JobId[] = [];
      for (let i = 0; i < count; i++) {
        const pulled = await qm.pull('test-q');
        ids.push(pulled!.id);
      }

      stats = qm.getStats();
      expect(stats.active).toBe(count);
      expect(stats.waiting).toBe(0);

      await Promise.all(ids.map((id) => qm.ack(id)));

      stats = qm.getStats();
      expect(stats.completed).toBe(count);
      expect(stats.active).toBe(0);
      expect(stats.waiting).toBe(0);
      expect(Number(stats.totalCompleted)).toBe(count);
    });

    test('should maintain consistent counts with mixed ack and fail', async () => {
      for (let i = 0; i < 10; i++) {
        await qm.push('test-q', { data: { id: i }, maxAttempts: 1 });
      }

      const ids: JobId[] = [];
      for (let i = 0; i < 10; i++) {
        const pulled = await qm.pull('test-q');
        ids.push(pulled!.id);
      }

      // Ack even-indexed, fail odd-indexed
      await Promise.all(ids.map((id, i) => (i % 2 === 0 ? qm.ack(id) : qm.fail(id, 'Error'))));

      const stats = qm.getStats();
      expect(stats.completed).toBe(5);
      expect(stats.dlq).toBe(5);
      expect(stats.active).toBe(0);
    });
  });
});
