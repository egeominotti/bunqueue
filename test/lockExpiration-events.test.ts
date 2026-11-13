/**
 * Lock Expiration Event Tests
 * Tests for the events the lock manager's expired lock handling emits:
 * `stalled` when an expired lock requeues the job, `failed` when max stalls
 * sends it to the DLQ. The expiration behaviour itself is in
 * lockExpiration.test.ts.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { shardIndex } from '../src/shared/hash';

describe('Lock Expiration', () => {
  let qm: QueueManager;

  beforeEach(() => {
    // The lock-expiration sweep runs every stallCheckMs (default 5 s): 50 ms here.
    qm = new QueueManager({ stallCheckMs: 50 });
  });

  afterEach(() => {
    qm.shutdown();
  });

  // Helper: pull with lock using a short TTL for testing
  async function pullWithLock(queue: string, ttlMs: number = 100) {
    return qm.pullWithLock(queue, 'test-worker', 0, ttlMs);
  }

  // Poll (up to 5 s) for the background sweep's result
  async function waitFor(done: () => boolean | Promise<boolean>, deadline = Date.now() + 5_000) {
    while (!(await done()) && Date.now() < deadline) await Bun.sleep(10);
  }

  describe('events', () => {
    test('stalled event is emitted when lock expires and job is requeued', async () => {
      const events: Array<{ eventType: string; jobId: string }> = [];
      qm.subscribe((event) => {
        if (event.eventType === 'stalled' || event.eventType === 'failed') {
          events.push({ eventType: event.eventType, jobId: event.jobId });
        }
      });

      await qm.push('events-test', { data: { msg: 'event' }, maxAttempts: 5 });
      const { job } = await pullWithLock('events-test', 50);

      expect(job).not.toBeNull();

      // Wait for lock to expire and be processed
      await waitFor(() => events.some((e) => e.eventType === 'stalled'));

      // Should have emitted a stalled event
      const stalledEvent = events.find(
        (e) => e.eventType === 'stalled' && e.jobId === String(job!.id)
      );
      expect(stalledEvent).toBeDefined();
    }, 15_000);

    test('failed event is emitted when max stalls reached', async () => {
      const queue = 'events-dlq';
      const idx = shardIndex(queue);
      qm.getShards()[idx].setStallConfig(queue, { maxStalls: 1 });

      const events: Array<{ eventType: string; jobId: string }> = [];
      qm.subscribe((event) => {
        if (event.eventType === 'stalled' || event.eventType === 'failed') {
          events.push({ eventType: event.eventType, jobId: event.jobId });
        }
      });

      await qm.push(queue, { data: { msg: 'fail-event' }, maxAttempts: 5 });
      const { job } = await pullWithLock(queue, 50);

      expect(job).not.toBeNull();

      // Wait for lock to expire and be processed
      await waitFor(() => events.some((e) => e.eventType === 'failed'));

      // Should have emitted a failed event (max stalls reached)
      const failedEvent = events.find(
        (e) => e.eventType === 'failed' && e.jobId === String(job!.id)
      );
      expect(failedEvent).toBeDefined();
    }, 15_000);
  });
});
