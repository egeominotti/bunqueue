/**
 * Overlapping recovery sweeps transition one delivery at most once.
 *
 * The stall checker, cleanup's orphan recovery and lock expiration each
 * re-verify under shardLocks -> processingLocks that the job object they
 * collected is still in processing and that their own trigger still holds for
 * the current delivery. The first transition removes the job from processing,
 * so the other sweep finds nothing to do, in either order.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { cleanup } from '../src/application/cleanupTasks';
import { checkExpiredLocks } from '../src/application/lockManager';
import { checkStalledJobs } from '../src/application/stallDetection';
import type { BackgroundContext, LockContext } from '../src/application/types';
import type { Job, JobLock } from '../src/domain/types/job';
import { processingShardIndex } from '../src/shared/hash';

type MutableLock = { -readonly [K in keyof JobLock]: JobLock[K] };
const QUEUED_STATES = ['waiting', 'prioritized', 'delayed'];

interface Contexts {
  getBackgroundContext(): BackgroundContext;
  getLockContext(): LockContext;
}

function contexts(qm: QueueManager): Contexts {
  return (qm as unknown as { contextFactory: Contexts }).contextFactory;
}

let qm: QueueManager | undefined;

afterEach(() => {
  qm?.shutdown();
  qm = undefined;
});

/** A job silent for 31 minutes, optionally holding an expired lease, with stalled events counted. */
async function silentJob(queue: string, withLease: boolean) {
  qm = new QueueManager();
  const ctx = contexts(qm).getBackgroundContext();
  const stalled: string[] = [];
  qm.subscribe((event) => {
    if (event.eventType === 'stalled') stalled.push(String(event.jobId));
  });
  await qm.push(queue, { data: {}, maxAttempts: 5 });
  const id = withLease
    ? (await qm.pullWithLock(queue, 'worker-1', 0, 60_000)).job!.id
    : (await qm.pull(queue))!.id;
  const job = ctx.processingShards[processingShardIndex(id)].get(id) as Job;
  const silentSince = Date.now() - 31 * 60 * 1000;
  job.startedAt = job.lastHeartbeat = silentSince;
  if (withLease) {
    const lease = ctx.jobLocks.get(id) as MutableLock;
    lease.createdAt = lease.lastRenewalAt = silentSince;
    lease.expiresAt = Date.now() - 1;
  }
  return { qm, ctx, id, stalled };
}

async function expectRecoveredOnce(
  qm: QueueManager,
  id: Job['id'],
  stalled: string[]
): Promise<void> {
  const job = await qm.getJob(id);
  expect(job?.attempts).toBe(1);
  expect(job?.stallCount).toBe(1);
  expect(QUEUED_STATES).toContain(await qm.getJobState(id));
  expect(stalled).toEqual([String(id)]);
}

describe('cleanup and the stall checker', () => {
  test('stall checker first, cleanup overlapping', async () => {
    const { qm, ctx, id, stalled } = await silentJob('stall-then-cleanup', false);
    checkStalledJobs(ctx); // candidate
    checkStalledJobs(ctx); // confirmed: the handler is now waiting for its locks
    await cleanup(ctx);
    await Bun.sleep(20);
    await expectRecoveredOnce(qm, id, stalled);
  });

  test('cleanup first, stall checker overlapping', async () => {
    const { qm, ctx, id, stalled } = await silentJob('cleanup-then-stall', false);
    checkStalledJobs(ctx); // candidate
    const sweep = cleanup(ctx);
    checkStalledJobs(ctx); // confirmed while the sweep holds or awaits the locks
    await sweep;
    await Bun.sleep(20);
    await expectRecoveredOnce(qm, id, stalled);
  });
});

describe('cleanup and lock expiration', () => {
  test('lock expiration first, cleanup overlapping', async () => {
    const { qm, ctx, id, stalled } = await silentJob('lock-then-cleanup', true);
    await Promise.all([checkExpiredLocks(contexts(qm).getLockContext()), cleanup(ctx)]);
    await expectRecoveredOnce(qm, id, stalled);
  });

  test('cleanup first, lock expiration overlapping', async () => {
    const { qm, ctx, id, stalled } = await silentJob('cleanup-then-lock', true);
    await Promise.all([cleanup(ctx), checkExpiredLocks(contexts(qm).getLockContext())]);
    await expectRecoveredOnce(qm, id, stalled);
  });
});
