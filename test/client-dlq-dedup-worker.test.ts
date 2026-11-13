/**
 * Comprehensive tests for client-side DLQ and Deduplication modules
 * Tests: dlq.ts, dlqOps.ts (worker integration, stats details)
 *
 * Run with: BUNQUEUE_EMBEDDED=1 bun test test/client-dlq-dedup-worker.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Queue, Worker, shutdownManager } from '../src/client';
import { addAndFailJob, inDlq, waitFor } from './support/client-dlq';

// ============================================================
// DLQ + WORKER INTEGRATION
// ============================================================
describe('DLQ Worker Integration', () => {
  let queue: Queue<Record<string, unknown>>;
  const QUEUE_NAME = 'dlq-worker-test';

  beforeEach(() => {
    queue = new Queue(QUEUE_NAME);
  });

  afterEach(() => {
    shutdownManager();
  });

  it('should move job to DLQ after max attempts exhausted via worker', async () => {
    let failCount = 0;
    const job = await queue.add('failing-job', { test: true }, { attempts: 1, backoff: 0 });

    const worker = new Worker(
      QUEUE_NAME,
      async () => {
        failCount++;
        throw new Error('always fails');
      },
      { concurrency: 1 }
    );

    await waitFor(inDlq(queue, job.id));
    await worker.close();

    expect(failCount).toBeGreaterThanOrEqual(1);

    const dlqEntries = queue.getDlq();
    const entry = dlqEntries.find((e) => e.job.id === job.id);
    expect(entry).toBeDefined();
    expect(entry!.reason).toBe('max_attempts_exceeded');
  });

  it('should retry a DLQ job and let it be processed again', async () => {
    let callCount = 0;

    const job = await queue.add('retry-me', { x: 1 }, { attempts: 1, backoff: 0 });

    // First worker: always fails
    const worker1 = new Worker(
      QUEUE_NAME,
      async () => {
        callCount++;
        throw new Error('fail first time');
      },
      { concurrency: 1 }
    );

    await waitFor(inDlq(queue, job.id));
    await worker1.close();

    // Verify job is in DLQ
    const dlqEntries = queue.getDlq();
    const entry = dlqEntries.find((e) => e.job.id === job.id);
    expect(entry).toBeDefined();

    // Retry from DLQ
    const retried = queue.retryDlq(job.id);
    expect(retried).toBe(1);

    // Second worker: succeeds
    const worker2 = new Worker(
      QUEUE_NAME,
      async () => {
        callCount++;
        return { success: true };
      },
      { concurrency: 1 }
    );

    await waitFor(async () => callCount >= 2 && (await queue.getJobState(job.id)) === 'completed');
    await worker2.close();

    // Should have been called at least twice (once fail, once success)
    expect(callCount).toBeGreaterThanOrEqual(2);

    // DLQ should not contain the job anymore
    const dlqAfter = queue.getDlq();
    const stillInDlq = dlqAfter.find((e) => e.job.id === job.id);
    expect(stillInDlq).toBeUndefined();
  });

  it('should keep error information in DLQ entry', async () => {
    const errorMsg = 'specific error message for DLQ test';

    const job = await queue.add('error-job', { e: 1 }, { attempts: 1, backoff: 0 });

    const worker = new Worker(
      QUEUE_NAME,
      async () => {
        throw new Error(errorMsg);
      },
      { concurrency: 1 }
    );

    await waitFor(inDlq(queue, job.id));
    await worker.close();

    const dlqEntries = queue.getDlq();
    const entry = dlqEntries.find((e) => e.job.id === job.id);
    expect(entry).toBeDefined();
    // The error message should be stored in the DLQ entry
    expect(entry!.error).toContain(errorMsg);
  });
});

// ============================================================
// DLQ STATS DETAILS
// ============================================================
describe('DLQ Stats Details', () => {
  let queue: Queue<Record<string, unknown>>;
  const QUEUE_NAME = 'dlq-stats-test';

  beforeEach(() => {
    queue = new Queue(QUEUE_NAME);
  });

  afterEach(() => {
    shutdownManager();
  });

  it('should update stats correctly as entries are added and removed', async () => {
    // Start empty
    let stats = queue.getDlqStats();
    expect(stats.total).toBe(0);

    // Add one
    await addAndFailJob(queue, QUEUE_NAME, { s: 1 });
    stats = queue.getDlqStats();
    expect(stats.total).toBeGreaterThanOrEqual(1);

    // Purge
    queue.purgeDlq();
    stats = queue.getDlqStats();
    expect(stats.total).toBe(0);
    expect(stats.oldestEntry).toBeNull();
    expect(stats.newestEntry).toBeNull();
  });
});
