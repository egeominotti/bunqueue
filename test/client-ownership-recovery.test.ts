/**
 * Client ownership across recovery (see repro-recovered-job-stale-client-release).
 *
 * - Every transition that ends a delivery without the owner's ACK/FAIL
 *   detaches the job from the owning connection.
 * - Defense in depth: disconnect release and its force-release fallback act
 *   only on a delivery the connection still owns, so even a stale
 *   registration cannot touch a later delivery owned by another worker.
 * - One delivery has one owner, and ownership of ended deliveries is pruned
 *   by cleanup (an outcome sent on another pooled connection leaves it).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { checkJobTimeouts } from '../src/application/backgroundTasks';
import { cleanup } from '../src/application/cleanupTasks';
import { checkExpiredLocks } from '../src/application/lockManager';
import { handleStalledJob } from '../src/application/stallDetection';
import type { BackgroundContext, LockContext } from '../src/application/types';
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

function processingJob(ctx: BackgroundContext, id: Job['id']): Job {
  const job = ctx.processingShards[processingShardIndex(id)].get(id);
  expect(job).toBeDefined();
  return job as Job;
}

function expectUnowned(ctx: BackgroundContext, id: Job['id']): void {
  expect(ctx.clientJobs.has('client-1')).toBe(false);
  expect(ctx.clientJobOwners.has(id)).toBe(false);
}

let qm: QueueManager | undefined;

afterEach(() => {
  qm?.shutdown();
  qm = undefined;
});

/** Push one job, pull it and register it to client-1 as the TCP handler does. */
async function ownedJob(queue: string, options: Record<string, unknown> = {}) {
  qm = new QueueManager();
  const ctx = contexts(qm).getBackgroundContext();
  await qm.push(queue, { data: {}, maxAttempts: 5, backoff: 0, ...options });
  const pulled = await qm.pullWithLock(queue, 'worker-1', 0, 60_000);
  const id = pulled.job!.id;
  qm.registerClientJob('client-1', id);
  expect(ctx.clientJobOwners.get(id)?.clientId).toBe('client-1');
  return { qm, ctx, id, token: pulled.token! };
}

describe('every delivery-ending transition detaches the owning client', () => {
  test('stall retry', async () => {
    const { ctx, id } = await ownedJob('detach-stall');
    await handleStalledJob(processingJob(ctx, id), StallAction.Retry, ctx);
    expectUnowned(ctx, id);
  });

  test('stall move to the DLQ', async () => {
    const { qm, ctx, id } = await ownedJob('detach-stall-dlq', { maxAttempts: 1 });
    await handleStalledJob(processingJob(ctx, id), StallAction.Retry, ctx);
    expect(await qm.getJobState(id)).toBe('failed');
    expectUnowned(ctx, id);
  });

  test('lock expiration', async () => {
    const { qm, ctx, id } = await ownedJob('detach-lock');
    (ctx.jobLocks.get(id) as MutableLock).expiresAt = Date.now() - 1;
    await checkExpiredLocks(contexts(qm).getLockContext());
    expectUnowned(ctx, id);
  });

  test('orphan recovery', async () => {
    const { ctx, id } = await ownedJob('detach-orphan');
    (ctx.jobLocks.get(id) as MutableLock).expiresAt = Date.now() - 1;
    const job = processingJob(ctx, id);
    job.startedAt = job.lastHeartbeat = Date.now() - 31 * 60 * 1000;
    await cleanup(ctx);
    expectUnowned(ctx, id);
  });

  test('processing timeout', async () => {
    const { ctx, id } = await ownedJob('detach-timeout', { timeout: 100 });
    processingJob(ctx, id).startedAt = Date.now() - 1_000;
    await checkJobTimeouts(ctx);
    expectUnowned(ctx, id);
  });

  test('management move back to wait', async () => {
    const { qm, ctx, id, token } = await ownedJob('detach-move');
    expect(await qm.moveActiveToWait(id, token)).toBe(true);
    expectUnowned(ctx, id);
  });
});

describe('disconnect release acts only on the delivery the client still owns', () => {
  /** client-1 loses the job, an unregistered worker gets it, a stale record survives. */
  async function staleRegistration() {
    const owned = await ownedJob('stale-record');
    const { qm, ctx, id } = owned;
    const staleRecord = ctx.clientJobOwners.get(id)!;
    await handleStalledJob(processingJob(ctx, id), StallAction.Retry, ctx);
    // Stall retry kept the old lease; date it before the next pull's generation.
    (ctx.jobLocks.get(id) as MutableLock).createdAt = Date.now() - 1_000;
    const next = await qm.pullWithLock('stale-record', 'embedded-worker', 0, 60_000);
    expect(next.job?.id).toBe(id);
    expect(next.token).not.toBeNull();
    // Model a transition that forgot to detach: the old record comes back.
    ctx.clientJobs.set('client-1', new Set([id]));
    ctx.clientJobOwners.set(id, staleRecord);
    return { ...owned, nextToken: next.token! };
  }

  test('releaseClientJobs leaves a later delivery alone', async () => {
    const { qm, ctx, id, nextToken } = await staleRegistration();
    expect(await qm.releaseClientJobs('client-1')).toBe(0);
    expect(await qm.getJobState(id)).toBe('active');
    expect(qm.verifyLock(id, nextToken)).toBe(true);
    expectUnowned(ctx, id);
  });

  test('forceReleaseClientJobs leaves a later delivery alone', async () => {
    const { qm, ctx, id, nextToken } = await staleRegistration();
    const startedAt = processingJob(ctx, id).startedAt;
    expect(qm.forceReleaseClientJobs('client-1')).toBe(0);
    expect(qm.verifyLock(id, nextToken)).toBe(true);
    expect(processingJob(ctx, id).startedAt).toBe(startedAt);
    expectUnowned(ctx, id);
  });

  test('registering a delivery moves it away from its previous owner', async () => {
    const { qm, ctx, id } = await ownedJob('transfer');
    qm.registerClientJob('client-2', id);
    expect(ctx.clientJobs.has('client-1')).toBe(false);
    expect(ctx.clientJobOwners.get(id)?.clientId).toBe('client-2');
    expect(await qm.releaseClientJobs('client-1')).toBe(0);
    expect(await qm.releaseClientJobs('client-2')).toBe(1);
  });
});

describe('cleanup prunes ownership of ended deliveries', () => {
  test('an ACK sent on another pooled connection no longer leaves the owner record behind', async () => {
    const { qm, ctx, id, token } = await ownedJob('pooled-ack');
    await qm.push('pooled-ack', { data: {} });
    const live = (await qm.pull('pooled-ack'))!.id;
    qm.registerClientJob('client-1', live);

    await qm.ack(id, { done: true }, token);
    qm.unregisterClientJob('client-2', id); // the ACK arrived on client-2
    expect(ctx.clientJobOwners.has(id)).toBe(true);

    await cleanup(ctx);

    expect(ctx.clientJobOwners.has(id)).toBe(false);
    expect([...(ctx.clientJobs.get('client-1') ?? [])]).toEqual([live]);
    expect(ctx.clientJobOwners.get(live)?.clientId).toBe('client-1');
  });
});
