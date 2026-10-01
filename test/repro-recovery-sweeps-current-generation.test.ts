/**
 * Repro: a recovery sweep acted on evidence that no longer described the
 * job's current delivery.
 *
 * 1. The stall checker confirms a stall, then waits for the stall-path locks.
 *    It passed no re-check to `handleStalledJob`, so a heartbeat that landed
 *    while it waited (or a fresh delivery of the same job object) was retried
 *    anyway: a live job ran twice.
 * 2. Stall retry keeps the previous lease as a stale-outcome guard. When the
 *    job was delivered again without a lease, the old lease's expiry was
 *    treated as the current delivery's lock expiry and reclaimed it.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { checkExpiredLocks } from '../src/application/lockManager';
import { checkStalledJobs, handleStalledJob } from '../src/application/stallDetection';
import type { BackgroundContext, LockContext } from '../src/application/types';
import type { Job, JobLock } from '../src/domain/types/job';
import { StallAction } from '../src/domain/types/stall';
import { processingShardIndex, shardIndex } from '../src/shared/hash';

type MutableLock = { -readonly [K in keyof JobLock]: JobLock[K] };

interface Contexts {
  getBackgroundContext(): BackgroundContext;
  getLockContext(): LockContext;
}

function contexts(qm: QueueManager): Contexts {
  return (qm as unknown as { contextFactory: Contexts }).contextFactory;
}

function processingJob(ctx: BackgroundContext, id: Job['id']): Job {
  const job = ctx.processingShards[processingShardIndex(id)].get(id);
  expect(job).toBeDefined();
  return job as Job;
}

let qm: QueueManager | undefined;

afterEach(() => {
  qm?.shutdown();
  qm = undefined;
});

describe('recovery sweeps act only on the current delivery', () => {
  test('a heartbeat that lands while the stall checker waits for the shard lock keeps the job', async () => {
    qm = new QueueManager();
    const ctx = contexts(qm).getBackgroundContext();
    await qm.push('stall-wait', { data: {}, maxAttempts: 5 });
    const id = (await qm.pull('stall-wait'))!.id;
    const job = processingJob(ctx, id);
    const silentSince = Date.now() - 60_000;
    job.startedAt = silentSince;
    job.lastHeartbeat = silentSince;

    checkStalledJobs(ctx); // first tick: candidate
    // Hold the queue shard so the confirmed stall waits for its first lock.
    const guard = await ctx.shardLocks[shardIndex('stall-wait')].acquireRead();
    try {
      checkStalledJobs(ctx); // second tick: confirmed, handler queued on the lock
      await Bun.sleep(5);
      expect(qm.jobHeartbeat(id)).toBe(true);
    } finally {
      guard.release();
    }
    await Bun.sleep(20);

    expect(await qm.getJobState(id)).toBe('active');
    expect((await qm.getJob(id))?.attempts).toBe(0);
    await qm.ack(id, { done: true });
    expect(await qm.getJobState(id)).toBe('completed');
  });

  test("an earlier delivery's expired lease does not reclaim a lockless re-delivery", async () => {
    qm = new QueueManager();
    const background = contexts(qm).getBackgroundContext();
    await qm.push('old-lease-expiry', { data: {}, maxAttempts: 5, backoff: 0 });

    const first = await qm.pullWithLock('old-lease-expiry', 'worker-1', 0, 60_000);
    const id = first.job!.id;
    // The first delivery stalls; stall retry keeps its lease as a stale-outcome guard.
    expect(
      await handleStalledJob(processingJob(background, id), StallAction.Retry, background)
    ).toBe(true);
    const oldLease = background.jobLocks.get(id) as MutableLock;
    expect(oldLease.token).toBe(first.token!);

    // The job is delivered again without a lease; the old lease predates it and lapses.
    expect((await qm.pull('old-lease-expiry'))?.id).toBe(id);
    oldLease.createdAt = processingJob(background, id).startedAt! - 1_000;
    oldLease.expiresAt = Date.now() - 1;
    await checkExpiredLocks(contexts(qm).getLockContext());

    expect(await qm.getJobState(id)).toBe('active');
    expect((await qm.getJob(id))?.attempts).toBe(1);
    // The stale lease is gone, so the current lockless delivery can finish.
    expect(background.jobLocks.has(id)).toBe(false);
    await qm.ack(id, { done: true });
    expect(await qm.getJobState(id)).toBe('completed');
  });
});
