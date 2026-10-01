/**
 * Guards around cleanup's orphan recovery (see repro-cleanup-orphan-recovery).
 *
 * - Lease generations: a lease counts as liveness only for the processing
 *   generation it was granted to. Pull stamps startedAt before the lease is
 *   created, so a lease from the current pull may share its millisecond and
 *   must still protect the job; a lease even one millisecond older than the
 *   current startedAt belongs to an earlier generation.
 * - The liveness re-check runs with both stall-path locks held, so a heartbeat
 *   that lands while the sweep waits for the shard lock keeps the job.
 * - Recovery is exactly once even when sweeps overlap, uses the stall budget,
 *   and discards cron preventOverlap jobs like every other stall path.
 * - Orphan recovery is a backstop for the stall checker: a queue with stall
 *   detection disabled is never swept (see
 *   repro-orphan-window-respects-stall-config).
 */

import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { cleanup } from '../src/application/cleanupTasks';
import type { BackgroundContext } from '../src/application/types';
import type { Job, JobLock } from '../src/domain/types/job';
import { processingShardIndex, shardIndex } from '../src/shared/hash';

const THIRTY_ONE_MINUTES = 31 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const TWO_HOURS = 2 * ONE_HOUR;
const QUEUED_STATES = ['waiting', 'prioritized', 'delayed'];

type MutableLock = { -readonly [K in keyof JobLock]: JobLock[K] };

function backgroundContext(qm: QueueManager): BackgroundContext {
  return (
    qm as unknown as { contextFactory: { getBackgroundContext(): BackgroundContext } }
  ).contextFactory.getBackgroundContext();
}

function processingJob(ctx: BackgroundContext, id: Job['id']): Job {
  const job = ctx.processingShards[processingShardIndex(id)].get(id);
  expect(job).toBeDefined();
  return job as Job;
}

function isProcessing(ctx: BackgroundContext, id: Job['id']): boolean {
  return ctx.processingShards[processingShardIndex(id)].has(id);
}

/** Nothing has been heard from the job for 31 minutes. */
function silence(job: Job): void {
  const longAgo = Date.now() - THIRTY_ONE_MINUTES;
  job.startedAt = longAgo;
  job.lastHeartbeat = longAgo;
}

let qm: QueueManager | undefined;

afterEach(() => {
  setSystemTime();
  qm?.shutdown();
  qm = undefined;
});

describe('orphan recovery: lease generations', () => {
  test('a lease created by the current pull in the same millisecond still protects the job', async () => {
    qm = new QueueManager();
    const ctx = backgroundContext(qm);
    await qm.push('same-ms', { data: {} });

    // Freeze the clock so the pull stamp and the lease share one millisecond.
    const pulledAt = Date.now();
    setSystemTime(new Date(pulledAt));
    const { job, token } = await qm.pullWithLock('same-ms', 'worker-1', 0, TWO_HOURS);
    expect(token).not.toBeNull();
    const id = job!.id;
    expect(processingJob(ctx, id).startedAt).toBe(pulledAt);
    expect(ctx.jobLocks.get(id)?.createdAt).toBe(pulledAt);

    // 31 minutes of silence with no renewal: only the unexpired lease is left.
    setSystemTime(new Date(pulledAt + THIRTY_ONE_MINUTES));
    await cleanup(ctx);

    expect(isProcessing(ctx, id)).toBe(true);
    expect(await qm.getJobState(id)).toBe('active');
    expect(qm.verifyLock(id, token!)).toBe(true);
    await qm.ack(id, { done: true }, token!);
    expect(await qm.getJobState(id)).toBe('completed');
  });

  test('a lease one millisecond older than the current generation is not liveness', async () => {
    qm = new QueueManager();
    const ctx = backgroundContext(qm);
    await qm.push('boundary', { data: {} });
    await qm.push('boundary', { data: {} });
    // Two jobs, each pulled with a lease, differ only in when their lease was created.
    const sameMs = (await qm.pullWithLock('boundary', 'worker-1', 0, TWO_HOURS)).job!.id;
    const olderMs = (await qm.pullWithLock('boundary', 'worker-1', 0, TWO_HOURS)).job!.id;

    for (const id of [sameMs, olderMs]) {
      const job = processingJob(ctx, id);
      silence(job);
      const lock = ctx.jobLocks.get(id) as MutableLock;
      lock.createdAt = id === sameMs ? job.startedAt! : job.startedAt! - 1;
      lock.lastRenewalAt = lock.createdAt;
      lock.expiresAt = Date.now() + ONE_HOUR;
    }

    await cleanup(ctx);

    expect(isProcessing(ctx, sameMs)).toBe(true);
    expect(await qm.getJobState(sameMs)).toBe('active');
    expect(isProcessing(ctx, olderMs)).toBe(false);
    expect(QUEUED_STATES).toContain(await qm.getJobState(olderMs));
  });
});

describe('orphan recovery: races and budgets', () => {
  test('a heartbeat that lands while the sweep waits for the shard lock keeps the job', async () => {
    qm = new QueueManager();
    const ctx = backgroundContext(qm);
    await qm.push('shard-wait', { data: {} });
    const id = (await qm.pull('shard-wait'))!.id;
    silence(processingJob(ctx, id));

    // Hold the queue shard (first lock of the stall path) between the sweep's phases.
    const guard = await ctx.shardLocks[shardIndex('shard-wait')].acquireRead();
    let sweep: Promise<void>;
    try {
      sweep = cleanup(ctx);
      await Bun.sleep(5);
      expect(isProcessing(ctx, id)).toBe(true);
      expect(qm.jobHeartbeat(id)).toBe(true);
    } finally {
      guard.release();
    }
    await sweep;

    expect(isProcessing(ctx, id)).toBe(true);
    expect(await qm.getJobState(id)).toBe('active');
    expect((await qm.getJob(id))?.attempts).toBe(0);
  });

  test('overlapping sweeps recover an orphan exactly once and announce it', async () => {
    qm = new QueueManager();
    const ctx = backgroundContext(qm);
    const dashboard: Array<{ event: string; data: Record<string, unknown> }> = [];
    ctx.dashboardEmit = (event, data) => dashboard.push({ event, data });
    const stalled: string[] = [];
    const unsubscribe = qm.subscribe((event) => {
      if (event.eventType === 'stalled') stalled.push(String(event.jobId));
    });

    await qm.push('overlap', { data: {}, maxAttempts: 5 });
    const id = (await qm.pull('overlap'))!.id;
    silence(processingJob(ctx, id));

    await Promise.all([cleanup(ctx), cleanup(ctx)]);
    unsubscribe();

    const job = await qm.getJob(id);
    expect(job?.attempts).toBe(1);
    expect(job?.stallCount).toBe(1);
    expect(QUEUED_STATES).toContain(await qm.getJobState(id));
    expect(stalled).toEqual([String(id)]);
    expect(dashboard.filter((e) => e.event === 'job:stalled')).toHaveLength(1);
    const orphanEvents = dashboard.filter((e) => e.event === 'cleanup:orphans-removed');
    expect(orphanEvents.map((e) => e.data.count)).toEqual([1]);
  });

  // Spec change: this case used a queue with stall detection disabled. Orphan
  // recovery must never contradict the stall configuration, so a disabled
  // queue is now skipped (next test). The stall budget is still proven on an
  // enabled queue: with maxStalls: 1 the first orphan recovery is terminal.
  test('an orphan consumes the stall budget: maxStalls: 1 moves it to the DLQ', async () => {
    qm = new QueueManager();
    const ctx = backgroundContext(qm);
    qm.setStallConfig('budget', { maxStalls: 1 });

    await qm.push('budget', { data: {}, maxAttempts: 5 });
    const id = (await qm.pull('budget'))!.id;
    silence(processingJob(ctx, id));

    await cleanup(ctx);

    expect(await qm.getJobState(id)).toBe('failed');
    expect(qm.getDlq('budget').map((job) => job.id)).toEqual([id]);
  });

  test('a queue with stall detection disabled is skipped even with maxStalls: 1', async () => {
    qm = new QueueManager();
    const ctx = backgroundContext(qm);
    qm.setStallConfig('budget-disabled', { enabled: false, maxStalls: 1 });

    await qm.push('budget-disabled', { data: {}, maxAttempts: 5 });
    const id = (await qm.pull('budget-disabled'))!.id;
    silence(processingJob(ctx, id));

    await cleanup(ctx);

    expect(isProcessing(ctx, id)).toBe(true);
    expect(await qm.getJobState(id)).toBe('active');
    expect((await qm.getJob(id))?.attempts).toBe(0);
    expect(qm.getDlq('budget-disabled')).toEqual([]);
  });

  test('a cron preventOverlap orphan is discarded and its unique key released', async () => {
    qm = new QueueManager();
    const ctx = backgroundContext(qm);

    const first = await qm.push('cron-orphan', { data: {}, uniqueKey: 'cron:nightly' });
    expect((await qm.pull('cron-orphan'))?.id).toBe(first.id);
    silence(processingJob(ctx, first.id));

    await cleanup(ctx);

    expect(isProcessing(ctx, first.id)).toBe(false);
    expect(ctx.jobIndex.has(first.id)).toBe(false);
    expect(qm.getDlq('cron-orphan')).toEqual([]);
    const next = await qm.push('cron-orphan', { data: {}, uniqueKey: 'cron:nightly' });
    expect(next.id).not.toBe(first.id);
    expect((await qm.pull('cron-orphan'))?.id).toBe(next.id);
  });
});
