/**
 * Repro: a job recovered from a silent client stays registered to that client.
 *
 * Stall recovery (also used by cleanup's orphan recovery) and lock expiration
 * requeue an active job without removing it from the silent connection's
 * clientJobs entry. When that connection finally closes, releaseClientJobs
 * finds the job active again under a NEW delivery to another client and
 * releases it back to the queue, so the live delivery is dispatched twice.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { checkExpiredLocks } from '../src/application/lockManager';
import { handleStalledJob } from '../src/application/stallDetection';
import type { BackgroundContext } from '../src/application/types';
import type { LockContext } from '../src/application/types';
import type { Job, JobLock } from '../src/domain/types/job';
import { StallAction } from '../src/domain/types/stall';
import { processingShardIndex } from '../src/shared/hash';

type MutableLock = { -readonly [K in keyof JobLock]: JobLock[K] };

interface Contexts {
  getBackgroundContext(): BackgroundContext;
  getLockContext(): LockContext;
}

function contexts(qm: QueueManager): Contexts {
  return (qm as unknown as { contextFactory: Contexts }).contextFactory;
}

function processingJob(qm: QueueManager, id: Job['id']): Job {
  const ctx = contexts(qm).getBackgroundContext();
  const job = ctx.processingShards[processingShardIndex(id)].get(id);
  expect(job).toBeDefined();
  return job as Job;
}

let qm: QueueManager | undefined;

afterEach(() => {
  qm?.shutdown();
  qm = undefined;
});

describe('a recovered job no longer belongs to the client that went silent', () => {
  test('after stall recovery, the old client disconnecting does not release the new delivery', async () => {
    qm = new QueueManager();
    const pushed = await qm.push('stale-client', { data: {}, maxAttempts: 5, backoff: 0 });

    const first = await qm.pull('stale-client');
    expect(first?.id).toBe(pushed.id);
    qm.registerClientJob('client-1', pushed.id);

    // client-1 went silent; the stall path (shared with orphan recovery) requeues it.
    const recovered = await handleStalledJob(
      processingJob(qm, pushed.id),
      StallAction.Retry,
      contexts(qm).getBackgroundContext()
    );
    expect(recovered).toBe(true);

    const second = await qm.pull('stale-client');
    expect(second?.id).toBe(pushed.id);
    qm.registerClientJob('client-2', pushed.id);

    // The silent connection finally closes.
    expect(await qm.releaseClientJobs('client-1')).toBe(0);
    expect(await qm.getJobState(pushed.id)).toBe('active');

    // The live delivery still belongs to client-2.
    expect(await qm.releaseClientJobs('client-2')).toBe(1);
  });

  test('after lock expiration, the old client disconnecting does not release the new delivery', async () => {
    qm = new QueueManager();
    const pushed = await qm.push('stale-lock-client', { data: {}, maxAttempts: 5, backoff: 0 });

    const first = await qm.pullWithLock('stale-lock-client', 'client-1', 0, 60_000);
    expect(first.job?.id).toBe(pushed.id);
    qm.registerClientJob('client-1', pushed.id);

    // client-1 stopped renewing: its lease lapses and lock expiration requeues the job.
    const lock = contexts(qm).getLockContext().jobLocks.get(pushed.id) as MutableLock;
    lock.expiresAt = Date.now() - 1;
    await checkExpiredLocks(contexts(qm).getLockContext());
    expect(await qm.getJobState(pushed.id)).not.toBe('active');

    const second = await qm.pullWithLock('stale-lock-client', 'client-2', 0, 60_000);
    expect(second.job?.id).toBe(pushed.id);
    qm.registerClientJob('client-2', pushed.id);

    expect(await qm.releaseClientJobs('client-1')).toBe(0);
    expect(await qm.getJobState(pushed.id)).toBe('active');
    expect(qm.verifyLock(pushed.id, second.token!)).toBe(true);
  });
});
