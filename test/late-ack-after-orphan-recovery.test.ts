/**
 * The silent original worker answers late, after cleanup's orphan recovery.
 *
 * Worker 1 pulled with a lease, went silent and let the lease lapse; orphan
 * recovery retried the job and cleanup removed the lapsed lease.
 *
 * - Before the job is delivered again there is no new delivery to corrupt.
 *   The late ACK is the stall-retried completion of Issue #33: it finishes the
 *   queued retry exactly once, so the work is not run a second time. A late
 *   FAIL is ignored and leaves the retry queued.
 * - After worker 2 has the job, worker 1's token is rejected for ACK and FAIL,
 *   and the new delivery stays active, owned by client-2 and ackable by
 *   worker 2 with its own token.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { cleanup } from '../src/application/cleanupTasks';
import type { BackgroundContext } from '../src/application/types';
import type { Job, JobLock } from '../src/domain/types/job';
import { processingShardIndex } from '../src/shared/hash';

type MutableLock = { -readonly [K in keyof JobLock]: JobLock[K] };
const QUEUED_STATES = ['waiting', 'prioritized', 'delayed'];

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

/** Worker 1 holds the job through client-1, falls silent, and orphan recovery retries it. */
async function orphanRecoveredJob(queue: string) {
  qm = new QueueManager();
  const ctx = backgroundContext(qm);
  await qm.push(queue, { data: {}, maxAttempts: 5, backoff: 0 });
  const first = await qm.pullWithLock(queue, 'worker-1', 0, 60_000);
  const id = first.job!.id;
  qm.registerClientJob('client-1', id);

  const lease = ctx.jobLocks.get(id) as MutableLock;
  const job = ctx.processingShards[processingShardIndex(id)].get(id) as Job;
  const silentSince = Date.now() - 31 * 60 * 1000;
  lease.createdAt = lease.lastRenewalAt = silentSince;
  lease.expiresAt = silentSince + 60_000;
  job.startedAt = job.lastHeartbeat = silentSince;

  await cleanup(ctx);
  expect(QUEUED_STATES).toContain(await qm.getJobState(id));
  expect((await qm.getJob(id))?.attempts).toBe(1);
  expect(ctx.jobLocks.has(id)).toBe(false);
  expect(ctx.clientJobs.has('client-1')).toBe(false);
  return { qm, ctx, id, staleToken: first.token! };
}

describe("the silent worker's late outcome after orphan recovery", () => {
  test('before re-delivery, a late ACK finishes the queued retry once', async () => {
    const { qm, id, staleToken } = await orphanRecoveredJob('late-before');

    await qm.ack(id, { by: 'worker-1' }, staleToken);

    expect(await qm.getJobState(id)).toBe('completed');
    expect(await qm.getResult(id)).toEqual({ by: 'worker-1' });
    expect(await qm.pull('late-before')).toBeNull(); // not run a second time
    expect(qm.getStats().active).toBe(0);
  });

  test('before re-delivery, a late FAIL is ignored and the retry stays queued', async () => {
    const { qm, id, staleToken } = await orphanRecoveredJob('late-fail-before');

    expect(await qm.fail(id, 'late failure', staleToken)).toEqual({
      applied: false,
      reason: 'already-finalized',
    });

    expect(QUEUED_STATES).toContain(await qm.getJobState(id));
    expect((await qm.getJob(id))?.attempts).toBe(1);
    expect((await qm.pull('late-fail-before'))?.id).toBe(id);
  });

  test('after re-delivery, the late ACK and FAIL are rejected and the new delivery is intact', async () => {
    const { qm, ctx, id, staleToken } = await orphanRecoveredJob('late-after');
    const second = await qm.pullWithLock('late-after', 'worker-2', 0, 60_000);
    expect(second.job?.id).toBe(id);
    expect(second.token).not.toBeNull();
    qm.registerClientJob('client-2', id);

    await expect(qm.ack(id, { by: 'worker-1' }, staleToken)).rejects.toThrow(
      /Invalid or expired lock token/
    );
    await expect(qm.fail(id, 'late failure', staleToken)).rejects.toThrow(
      /Invalid or expired lock token/
    );

    expect(await qm.getJobState(id)).toBe('active');
    expect((await qm.getJob(id))?.attempts).toBe(1);
    expect(qm.verifyLock(id, second.token!)).toBe(true);
    expect(ctx.clientJobOwners.get(id)?.clientId).toBe('client-2');
    expect(await qm.releaseClientJobs('client-1')).toBe(0);

    await qm.ack(id, { by: 'worker-2' }, second.token!);
    expect(await qm.getJobState(id)).toBe('completed');
    expect(await qm.getResult(id)).toEqual({ by: 'worker-2' });
  });
});
