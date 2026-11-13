/**
 * Bug #28: Invalid or expired lock token
 *
 * Race condition: when a lock expires while a worker is still processing,
 * the background lock expiration task removes the lock and requeues the job.
 * Previously, fail() would throw "Invalid or expired lock token".
 *
 * Fix: fail()/ack() now return the broker-authoritative already-finalized
 * outcome when the lock was already cleaned up by the background task, but
 * still throw on genuine ownership conflicts.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import type { JobId } from '../src/domain/types/job';

describe('Bug #28: Invalid or expired lock token at high concurrency', () => {
  let qm: QueueManager;

  beforeEach(() => {
    // The lock-expiration sweep runs every stallCheckMs (default 5 s): 50 ms here.
    qm = new QueueManager({ stallCheckMs: 50 });
  });

  afterEach(() => {
    qm.shutdown();
  });

  // Poll (up to 5 s) until the background sweep has removed the lease and requeued the job.
  const requeued = async (id: JobId) =>
    qm.getLockInfo(id) === null && ['waiting', 'delayed'].includes(await qm.getJobState(id));
  async function waitForRequeue(ids: JobId[], deadline = Date.now() + 5_000): Promise<void> {
    const done = async () => (await Promise.all(ids.map(requeued))).every(Boolean);
    while (!(await done()) && Date.now() < deadline) await Bun.sleep(10);
  }

  test('fail() gracefully returns after lock expired and was cleaned by background task', async () => {
    await qm.push('race-test', { data: { msg: 'slow-job' }, maxAttempts: 5 });

    const { job, token } = await qm.pullWithLock('race-test', 'worker-A', 0, 50);
    expect(job).not.toBeNull();
    expect(token).not.toBeNull();

    const jobId = job!.id;
    const oldToken = token!;

    // Wait for lock to expire
    await Bun.sleep(100);
    expect(qm.verifyLock(jobId, oldToken)).toBe(false);

    // Wait for background lock expiration task to clean up
    await waitForRequeue([jobId]);

    expect(qm.getLockInfo(jobId)).toBeNull();
    const state = await qm.getJobState(jobId);
    expect(['waiting', 'delayed']).toContain(state);

    // The stale failure is accepted as a no-op with an explicit terminal outcome.
    await expect(qm.fail(jobId, 'processing error', oldToken)).resolves.toEqual({
      applied: false,
      reason: 'already-finalized',
    });
  }, 15_000);

  test('fail() still throws on genuine ownership conflict', async () => {
    await qm.push('conflict-test', { data: { msg: 'contested-job' }, maxAttempts: 5 });

    const { job, token: tokenA } = await qm.pullWithLock('conflict-test', 'worker-A', 0, 50);
    expect(job).not.toBeNull();
    const jobId = job!.id;

    // Wait for lock to expire + background task to requeue
    await waitForRequeue([jobId]);
    const state = await qm.getJobState(jobId);
    expect(['waiting', 'delayed']).toContain(state);

    // Worker B pulls the same job (new lock) once the retry backoff allows it, up to 5 s
    let pulled = await qm.pullWithLock('conflict-test', 'worker-B', 0, 30_000);
    for (const deadline = Date.now() + 5_000; !pulled.job && Date.now() < deadline;) {
      await Bun.sleep(20);
      pulled = await qm.pullWithLock('conflict-test', 'worker-B', 0, 30_000);
    }

    if (pulled.job) {
      expect(pulled.token).not.toBe(tokenA);
      // Worker A tries fail() with old token while Worker B holds the lock → should throw
      await expect(qm.fail(jobId, 'late failure', tokenA!)).rejects.toThrow(
        /Invalid or expired lock token/
      );
    } else {
      expect(qm.verifyLock(jobId, tokenA!)).toBe(false);
    }
  }, 20_000);

  test('50 concurrent workers: fail() gracefully handles expired locks', async () => {
    const WORKER_COUNT = 50;
    const QUEUE = 'high-concurrency';

    for (let i = 0; i < WORKER_COUNT; i++) {
      await qm.push(QUEUE, { data: { idx: i }, maxAttempts: 3 });
    }

    const pulled: Array<{ jobId: JobId; token: string }> = [];
    for (let i = 0; i < WORKER_COUNT; i++) {
      const { job, token } = await qm.pullWithLock(QUEUE, `worker-${i}`, 0, 100);
      if (job && token) pulled.push({ jobId: job.id, token });
    }
    expect(pulled.length).toBe(WORKER_COUNT);

    await waitForRequeue(pulled.map((p) => p.jobId));

    // FIX: All fail() calls should resolve gracefully
    const results = await Promise.allSettled(
      pulled.map(({ jobId, token }) => qm.fail(jobId, 'timeout', token))
    );
    const errors = results.filter((r) => r.status === 'rejected');
    expect(errors.length).toBe(0);
  }, 20_000);

  test('ack() also gracefully handles expired locks', async () => {
    await qm.push('ack-race', { data: { msg: 'ack-test' }, maxAttempts: 5 });

    const { job, token } = await qm.pullWithLock('ack-race', 'worker-A', 0, 50);
    expect(job).not.toBeNull();

    await waitForRequeue([job!.id]);

    await expect(qm.ack(job!.id, { done: true }, token!)).resolves.toBeUndefined();
  }, 15_000);
});
