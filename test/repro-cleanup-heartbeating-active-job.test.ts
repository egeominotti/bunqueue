/**
 * Repro: periodic cleanup must not drop a long-running job that is still alive.
 *
 * cleanOrphanedProcessingEntries removed every processing entry whose startedAt
 * was more than 30 minutes old, without looking at its heartbeat. A legitimate
 * job that kept heartbeating vanished from processingShards and jobIndex with
 * no state transition, so its worker could no longer acknowledge it.
 *
 * Liveness covers token-less heartbeats, lock renewals (the default worker
 * path, useLocks: true) and an unexpired lock lease, and it is re-checked under
 * the processing write lock because a heartbeat can land between the sweep's
 * collection and deletion phases.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { cleanup } from '../src/application/cleanupTasks';
import type { BackgroundContext } from '../src/application/types';
import type { Job, JobLock } from '../src/domain/types/job';
import { processingShardIndex } from '../src/shared/hash';

const THIRTY_ONE_MINUTES = 31 * 60 * 1000;
const TWO_HOURS = 2 * 60 * 60 * 1000;

type MutableLock = { -readonly [K in keyof JobLock]: JobLock[K] };

function processingJob(ctx: BackgroundContext, id: Job['id']): Job {
  const job = ctx.processingShards[processingShardIndex(id)].get(id);
  expect(job).toBeDefined();
  return job as Job;
}

/** Make the entry look as if it was pulled, and last heard from, 31 minutes ago. */
function ageLiveness(job: Job): void {
  const longAgo = Date.now() - THIRTY_ONE_MINUTES;
  job.startedAt = longAgo;
  job.lastHeartbeat = longAgo;
}

function backgroundContext(qm: QueueManager): BackgroundContext {
  return (
    qm as unknown as { contextFactory: { getBackgroundContext(): BackgroundContext } }
  ).contextFactory.getBackgroundContext();
}

let qm: QueueManager | undefined;

afterEach(() => {
  qm?.shutdown();
  qm = undefined;
});

describe('cleanup keeps long-running jobs that still heartbeat', () => {
  test('a job started 31 minutes ago with a fresh heartbeat stays active and can be acknowledged', async () => {
    qm = new QueueManager();
    const ctx = backgroundContext(qm);

    const pushed = await qm.push('long-running', { data: { step: 'export' } });
    const pulled = await qm.pull('long-running');
    expect(pulled?.id).toBe(pushed.id);
    const id = pulled!.id;

    const procIdx = processingShardIndex(id);
    const live = ctx.processingShards[procIdx].get(id) as Job;
    (live as { startedAt: number | null }).startedAt = Date.now() - THIRTY_ONE_MINUTES;

    // The worker is alive: it heartbeats right before the cleanup pass.
    expect(qm.jobHeartbeat(id)).toBe(true);

    await cleanup(ctx);

    expect(ctx.processingShards[procIdx].has(id)).toBe(true);
    expect(ctx.jobIndex.get(id)?.type).toBe('processing');
    expect(await qm.getJobState(id)).toBe('active');

    await qm.ack(id, { exported: true });
    expect(await qm.getJobState(id)).toBe('completed');
  });

  test('a lock-holding job whose worker renews the lease stays active and can be acknowledged with its token', async () => {
    qm = new QueueManager();
    const ctx = backgroundContext(qm);

    await qm.push('long-running-locked', { data: { step: 'export' } });
    const { job, token } = await qm.pullWithLock('long-running-locked', 'worker-1');
    expect(job).not.toBeNull();
    expect(token).not.toBeNull();
    const id = job!.id;

    // The job has been running for 31 minutes; the worker kept renewing its
    // 30s lease, so the lock is still unexpired.
    ageLiveness(processingJob(ctx, id));
    const lock = ctx.jobLocks.get(id) as MutableLock;
    lock.createdAt = Date.now() - THIRTY_ONE_MINUTES;

    // Default worker heartbeat path: JobHeartbeat with the lock token.
    expect(qm.jobHeartbeat(id, token!)).toBe(true);

    await cleanup(ctx);

    expect(ctx.processingShards[processingShardIndex(id)].has(id)).toBe(true);
    expect(ctx.jobIndex.get(id)?.type).toBe('processing');
    expect(qm.verifyLock(id, token!)).toBe(true);
    expect(await qm.getJobState(id)).toBe('active');

    await qm.ack(id, { exported: true }, token!);
    expect(await qm.getJobState(id)).toBe('completed');
  });

  test('an unexpired lock lease keeps the job even when no heartbeat arrived for 31 minutes', async () => {
    qm = new QueueManager();
    const ctx = backgroundContext(qm);

    await qm.push('long-lease', { data: { step: 'export' } });
    // lockDuration of two hours with no renewals: the broker granted ownership
    // until the lease expires, and lock expiration owns that decision.
    const { job, token } = await qm.pullWithLock('long-lease', 'worker-1', 0, TWO_HOURS);
    expect(token).not.toBeNull();
    const id = job!.id;

    ageLiveness(processingJob(ctx, id));
    const lock = ctx.jobLocks.get(id) as MutableLock;
    lock.createdAt = Date.now() - THIRTY_ONE_MINUTES;
    lock.lastRenewalAt = lock.createdAt;
    lock.expiresAt = lock.createdAt + TWO_HOURS;

    await cleanup(ctx);

    expect(ctx.processingShards[processingShardIndex(id)].has(id)).toBe(true);
    expect(ctx.jobIndex.get(id)?.type).toBe('processing');
    expect(await qm.getJobState(id)).toBe('active');

    await qm.ack(id, { exported: true }, token!);
    expect(await qm.getJobState(id)).toBe('completed');
  });

  test('a heartbeat that lands while the sweep waits for the write lock keeps the job', async () => {
    qm = new QueueManager();
    const ctx = backgroundContext(qm);

    await qm.push('late-heartbeat', { data: { step: 'export' } });
    const pulled = await qm.pull('late-heartbeat');
    const id = pulled!.id;
    const procIdx = processingShardIndex(id);

    // Silent for 31 minutes: phase 1 of the sweep selects it as an orphan.
    ageLiveness(processingJob(ctx, id));

    // Hold the processing shard so the sweep blocks between its two phases.
    const guard = await ctx.processingLocks[procIdx].acquireRead();
    let sweep: Promise<void>;
    try {
      sweep = cleanup(ctx);
      await Bun.sleep(5);
      expect(ctx.processingShards[procIdx].has(id)).toBe(true);

      // The worker heartbeats before the sweep acquires the write lock.
      expect(qm.jobHeartbeat(id)).toBe(true);
    } finally {
      guard.release();
    }
    await sweep;

    expect(ctx.processingShards[procIdx].has(id)).toBe(true);
    expect(ctx.jobIndex.get(id)?.type).toBe('processing');
    expect(await qm.getJobState(id)).toBe('active');

    await qm.ack(id, { exported: true });
    expect(await qm.getJobState(id)).toBe('completed');
  });

  test('a silent job whose lock lease already expired is still removed as an orphan', async () => {
    qm = new QueueManager();
    const ctx = backgroundContext(qm);

    await qm.push('dead-worker', { data: { step: 'export' } });
    const { job, token } = await qm.pullWithLock('dead-worker', 'worker-1');
    expect(token).not.toBeNull();
    const id = job!.id;

    // The worker died 31 minutes ago: no heartbeat and its 30s lease lapsed.
    ageLiveness(processingJob(ctx, id));
    const lock = ctx.jobLocks.get(id) as MutableLock;
    lock.createdAt = Date.now() - THIRTY_ONE_MINUTES;
    lock.lastRenewalAt = lock.createdAt;
    lock.expiresAt = lock.createdAt + lock.ttl;

    await cleanup(ctx);

    expect(ctx.processingShards[processingShardIndex(id)].has(id)).toBe(false);
    expect(ctx.jobIndex.has(id)).toBe(false);
    expect(ctx.jobLocks.has(id)).toBe(false);
  });
});
