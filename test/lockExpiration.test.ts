/**
 * Lock Expiration Tests
 * Tests for the lock manager's expired lock detection and handling.
 * Covers: lock lifecycle, expiration requeue, max stalls to DLQ,
 * batch expiration processing, and stall events. Token checks, release on
 * ack/fail and re-pulling a requeued job are in lockManager.test.ts and
 * lock-race-conditions.test.ts.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { shardIndex } from '../src/shared/hash';
import type { JobId } from '../src/domain/types/job';

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
  const requeued = async (id: JobId) =>
    qm.getLockInfo(id) === null && ['waiting', 'delayed'].includes(await qm.getJobState(id));

  describe('lock lifecycle', () => {
    test('lock that has not expired is not affected by expiration check', async () => {
      await qm.push('tasks', { data: { msg: 'keep-alive' } });
      const { job, token } = await pullWithLock('tasks', 60_000); // 60s TTL

      expect(job).not.toBeNull();
      expect(token).not.toBeNull();

      // Lock exists and is valid
      expect(qm.verifyLock(job!.id, token!)).toBe(true);

      // Stats show 1 active job
      const statsBefore = qm.getStats();
      expect(statsBefore.active).toBe(1);
      expect(statsBefore.waiting).toBe(0);

      // The lock has a long TTL, so the expiration check changes nothing
      const lockInfo = qm.getLockInfo(job!.id);
      expect(lockInfo).not.toBeNull();
      expect(lockInfo!.expiresAt).toBeGreaterThan(Date.now());

      // Job should still be active after check
      const statsAfter = qm.getStats();
      expect(statsAfter.active).toBe(1);
      expect(statsAfter.waiting).toBe(0);

      // Lock is still valid
      expect(qm.verifyLock(job!.id, token!)).toBe(true);
    });

    test('lock can be renewed before expiration', async () => {
      await qm.push('tasks', { data: { msg: 'renewable' } });
      const { job, token } = await pullWithLock('tasks', 500);

      expect(job).not.toBeNull();
      expect(token).not.toBeNull();

      // Renew the lock with extended TTL
      const renewed = qm.renewJobLock(job!.id, token!, 60_000);
      expect(renewed).toBe(true);

      // Lock info should have updated expiration
      const lockInfo = qm.getLockInfo(job!.id);
      expect(lockInfo).not.toBeNull();
      expect(lockInfo!.renewalCount).toBe(1);
      expect(lockInfo!.expiresAt).toBeGreaterThan(Date.now() + 50_000);
    });
  });

  describe('expired lock triggers job requeue', () => {
    test('expired lock causes job to be requeued', async () => {
      await qm.push('tasks', { data: { msg: 'will-expire' }, maxAttempts: 5 });
      const { job, token } = await pullWithLock('tasks', 50); // 50ms TTL

      expect(job).not.toBeNull();
      expect(token).not.toBeNull();

      // Verify job is active
      const state1 = await qm.getJobState(job!.id);
      expect(state1).toBe('active');

      // Wait for lock to expire
      await new Promise((r) => setTimeout(r, 100));

      // Verify lock has expired
      expect(qm.verifyLock(job!.id, token!)).toBe(false);

      // Wait for the background lock-expiration sweep (every stallCheckMs).
      await waitFor(() => requeued(job!.id));

      // After expiration processing, job should be requeued (waiting or delayed)
      const state2 = await qm.getJobState(job!.id);
      expect(['waiting', 'delayed']).toContain(state2);

      // Lock should be cleaned up
      const lockInfo = qm.getLockInfo(job!.id);
      expect(lockInfo).toBeNull();

      // Stats should show no active jobs (removed from processing)
      const stats = qm.getStats();
      expect(stats.active).toBe(0);
    }, 15_000);

    test('expired lock increments stallCount', async () => {
      await qm.push('tasks', { data: { msg: 'stall-count' }, maxAttempts: 10 });
      const { job } = await pullWithLock('tasks', 50);

      expect(job).not.toBeNull();
      const jobId = job!.id;

      // Wait for lock to expire and be processed
      await waitFor(() => requeued(jobId));

      // Get the requeued job and check stallCount
      const requeuedJob = await qm.getJob(jobId);
      expect(requeuedJob).not.toBeNull();
      expect(requeuedJob!.stallCount).toBeGreaterThanOrEqual(1);
      expect(requeuedJob!.attempts).toBeGreaterThanOrEqual(1);
    }, 15_000);
  });

  describe('max stalls sends to DLQ', () => {
    test('job with expired lock exceeding max stalls goes to DLQ', async () => {
      const queue = 'dlq-test';

      // Set stall config with maxStalls = 1 so first expiration sends to DLQ
      const idx = shardIndex(queue);
      qm.getShards()[idx].setStallConfig(queue, { maxStalls: 1 });

      await qm.push(queue, { data: { msg: 'will-dlq' }, maxAttempts: 5 });
      const { job } = await pullWithLock(queue, 50);

      expect(job).not.toBeNull();

      // Wait for lock to expire and be processed
      await waitFor(async () => (await qm.getJobState(job!.id)) === 'failed');

      // Job should be in DLQ now (stallCount becomes 1, >= maxStalls of 1)
      const state = await qm.getJobState(job!.id);
      expect(state).toBe('failed');

      // DLQ should have the entry
      const dlqEntries = qm.getDlq(queue);
      expect(dlqEntries.length).toBeGreaterThanOrEqual(1);

      const dlqJob = dlqEntries.find((j) => j.id === job!.id);
      expect(dlqJob).toBeDefined();

      // Lock should be cleaned up
      expect(qm.getLockInfo(job!.id)).toBeNull();

      // Stats should reflect DLQ
      const stats = qm.getStats();
      expect(stats.active).toBe(0);
      expect(stats.dlq).toBeGreaterThanOrEqual(1);
    }, 15_000);
  });

  describe('multiple expired locks', () => {
    test('multiple expired locks are processed correctly', async () => {
      const queue = 'multi-expire';

      // Push several jobs
      const pushCount = 5;
      for (let i = 0; i < pushCount; i++) {
        await qm.push(queue, { data: { idx: i }, maxAttempts: 10 });
      }

      // Pull all with short lock TTL
      const pulled: Array<Awaited<ReturnType<typeof pullWithLock>>> = [];
      for (let i = 0; i < pushCount; i++) {
        const result = await pullWithLock(queue, 50);
        pulled.push(result);
      }

      // Verify all are active with locks
      for (const p of pulled) {
        expect(p.job).not.toBeNull();
        expect(p.token).not.toBeNull();
        expect(qm.getLockInfo(p.job!.id)).not.toBeNull();
      }

      // Stats: all active
      const stats1 = qm.getStats();
      expect(stats1.active).toBe(pushCount);

      // Wait for all locks to expire and be processed
      await waitFor(async () =>
        (await Promise.all(pulled.map((p) => requeued(p.job!.id)))).every(Boolean)
      );

      // All locks should be cleaned up
      for (const p of pulled) expect(qm.getLockInfo(p.job!.id)).toBeNull();

      // All jobs should be requeued (not active)
      const stats2 = qm.getStats();
      expect(stats2.active).toBe(0);

      // Verify each job's state individually (more reliable than aggregate stats)
      for (const p of pulled) {
        const state = await qm.getJobState(p.job!.id);
        expect(['waiting', 'delayed']).toContain(state);
      }
    }, 15_000);

    test('batch expiration with mixed TTLs', async () => {
      const queue = 'mixed-ttl';

      // Push 2 jobs
      await qm.push(queue, { data: { msg: 'short' }, maxAttempts: 5 });
      await qm.push(queue, { data: { msg: 'long' }, maxAttempts: 5 });

      // Pull first with short TTL, second with long TTL
      const short = await qm.pullWithLock(queue, 'worker-a', 0, 50);
      const long = await qm.pullWithLock(queue, 'worker-b', 0, 60_000);

      expect(short.job).not.toBeNull();
      expect(long.job).not.toBeNull();

      // Short lock processed, then ~10 more sweeps over the still-valid long lock
      await waitFor(() => requeued(short.job!.id));
      await Bun.sleep(500);

      // Short lock should be cleaned up, long lock should still be valid
      expect(qm.getLockInfo(short.job!.id)).toBeNull();
      expect(qm.getLockInfo(long.job!.id)).not.toBeNull();
      expect(qm.verifyLock(long.job!.id, long.token!)).toBe(true);

      // Short job requeued, long job still active
      const shortState = await qm.getJobState(short.job!.id);
      expect(['waiting', 'delayed']).toContain(shortState);

      const longState = await qm.getJobState(long.job!.id);
      expect(longState).toBe('active');
    }, 15_000);
  });

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
