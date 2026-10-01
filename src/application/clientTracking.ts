/**
 * Client Tracking - Client-job relationship management
 * Handles job ownership and release on client disconnect
 */

import type { Job, JobId } from '../domain/types/job';
import { shardIndex } from '../shared/hash';
import { withWriteLock } from '../shared/lock';
import { detachClientJob, dropClient, ownsCurrentDelivery } from './clientOwnership';
import type { LockContext } from './types';

export { registerClientJob, unregisterClientJob } from './clientOwnership';

/**
 * A disconnecting client may release only a delivery it still owns, and only
 * when no renewal proves a worker is still holding it.
 *
 * A job whose lock has been renewed since pull (renewalCount > 0) is being
 * actively heartbeated by a live worker. With a pooled client, heartbeats
 * travel on a DIFFERENT connection than the one that pulled, so THIS socket
 * closing does not mean the worker died — re-queuing here would re-dispatch
 * (double-execute) a job the worker still holds. Leave it; lock expiry /
 * stall detection reclaims it if the worker truly stops heartbeating.
 * A never-renewed lock (renewalCount === 0) keeps the original fast-recovery
 * behavior: requeue immediately on disconnect.
 */
function isReleasable(clientId: string, jobId: JobId, ctx: LockContext): boolean {
  if (!ownsCurrentDelivery(clientId, jobId, ctx)) return false;
  const lock = ctx.jobLocks.get(jobId);
  return !(lock && lock.renewalCount > 0);
}

/**
 * Release all jobs owned by a client back to queue (called on TCP disconnect).
 * Returns the number of jobs released.
 *
 * Only deliveries the client still owns are touched (`ownsCurrentDelivery`): a
 * job recovered from this client and delivered again to another worker is not
 * this client's to release. The rule is checked when collecting and again
 * under the shard and processing write locks.
 */
export async function releaseClientJobs(clientId: string, ctx: LockContext): Promise<number> {
  const jobs = ctx.clientJobs.get(clientId);
  if (!jobs || jobs.size === 0) {
    dropClient(clientId, ctx);
    return 0;
  }

  // Phase 1: Collect jobs to release (read-only, no locks needed)
  const jobsToRelease: Array<{
    jobId: JobId;
    procIdx: number;
    queueShardIdx: number;
  }> = [];

  for (const jobId of jobs) {
    const loc = ctx.jobIndex.get(jobId);
    if (loc?.type !== 'processing') continue;
    if (!isReleasable(clientId, jobId, ctx)) continue;

    const procIdx = loc.shardIdx;
    const job = ctx.processingShards[procIdx].get(jobId);
    if (!job) continue;

    jobsToRelease.push({
      jobId,
      procIdx,
      queueShardIdx: shardIndex(job.queue),
    });
  }

  if (jobsToRelease.length === 0) {
    dropClient(clientId, ctx);
    return 0;
  }

  // Phase 2: Group by processing shard for efficient locking
  const byProcShard = new Map<number, typeof jobsToRelease>();
  for (const item of jobsToRelease) {
    let list = byProcShard.get(item.procIdx);
    if (!list) {
      list = [];
      byProcShard.set(item.procIdx, list);
    }
    list.push(item);
  }

  let released = 0;
  const now = Date.now();

  try {
    // Phase 3: Process each processing shard with proper locking
    // Lock order: shardLocks BEFORE processingLocks (per lock hierarchy in CLAUDE.md)
    for (const [procIdx, items] of byProcShard) {
      // Group items by queue shard to minimize lock acquisitions
      const byQueueShard = new Map<number, typeof items>();
      for (const item of items) {
        let list = byQueueShard.get(item.queueShardIdx);
        if (!list) {
          list = [];
          byQueueShard.set(item.queueShardIdx, list);
        }
        list.push(item);
      }

      // Acquire shard locks first, then processing lock
      for (const [queueShardIdx, shardItems] of byQueueShard) {
        await withWriteLock(ctx.shardLocks[queueShardIdx], async () => {
          await withWriteLock(ctx.processingLocks[procIdx], () => {
            for (const { jobId } of shardItems) {
              const job = ctx.processingShards[procIdx].get(jobId);
              if (!job || !isReleasable(clientId, jobId, ctx)) continue;
              released += releaseJobToQueue({ jobId, job, procIdx, queueShardIdx, ctx, now });
            }
          });
        });
      }
    }

    return released;
  } finally {
    // Always clear client tracking, even if locking failed mid-flight.
    // Prevents a leak in ctx.clientJobs that would otherwise accumulate
    // across every TCP disconnect that hit a lock timeout. Jobs left in
    // 'active' state will be recovered by the stall detector on its next tick.
    dropClient(clientId, ctx);
  }
}

/**
 * Force-release client tracking without acquiring queue locks.
 * Used as a last-resort fallback when releaseClientJobs has exhausted its
 * retry budget (e.g. persistent lock contention on TCP disconnect). For each
 * job whose current delivery the client still owns (`ownsCurrentDelivery`;
 * a stale registration must not expire another worker's delivery):
 *   - clears `jobLocks` so a stale lock token can't survive the disconnect
 *     until its TTL expires;
 *   - expires both `lastHeartbeat` (so stall detection's heartbeat check
 *     fires) and `startedAt` (so the gracePeriod check passes immediately).
 *
 * Recovery latency: stall detection uses two-phase confirmation
 * (stalledCandidates collected on one tick, acted on the next), so a job is
 * recovered within ~2 stall-check ticks (≈10s with defaults). This is faster
 * than the full stallTimeout (30s default) but NOT instant.
 *
 * This path runs lock-free: callers must accept that another path (stall
 * detector, lock expiration) may concurrently mutate or remove the same job
 * from processingShards. Worst case: our mutation lands on an object that is
 * no longer in the Map, wasting the write. Never corrupts state.
 *
 * Returns the number of jobs whose state was reset.
 */
export function forceReleaseClientJobs(clientId: string, ctx: LockContext): number {
  const jobs = ctx.clientJobs.get(clientId);
  if (!jobs || jobs.size === 0) {
    dropClient(clientId, ctx);
    return 0;
  }

  let touched = 0;
  for (const jobId of jobs) {
    // Not this client's delivery any more (recovered, finished, or delivered
    // again to another worker): its lock and timers belong to someone else.
    if (!ownsCurrentDelivery(clientId, jobId, ctx)) continue;
    // Drop this delivery's lock token so it cannot survive the disconnect.
    ctx.jobLocks.delete(jobId);

    const loc = ctx.jobIndex.get(jobId);
    if (loc?.type !== 'processing') continue;
    const job = ctx.processingShards[loc.shardIdx].get(jobId);
    if (!job) continue;
    // Expire heartbeat AND startedAt so the stall detector's grace-period
    // gate passes on the next eligible tick.
    job.lastHeartbeat = 0;
    job.startedAt = 0;
    ctx.timeoutScheduler.cancel(jobId);
    touched++;
  }

  dropClient(clientId, ctx);
  return touched;
}

/** Options for releasing a job back to queue */
interface ReleaseJobOptions {
  jobId: JobId;
  job: Job;
  procIdx: number;
  queueShardIdx: number;
  ctx: LockContext;
  now: number;
}

/** Release a single job back to queue */
function releaseJobToQueue(opts: ReleaseJobOptions): number {
  const { jobId, job, procIdx, queueShardIdx, ctx, now } = opts;
  const shard = ctx.shards[queueShardIdx];

  // Remove from processing
  ctx.processingShards[procIdx].delete(jobId);
  ctx.timeoutScheduler.cancel(jobId);

  // Release lock if exists; the delivery ends here, so does its ownership.
  ctx.jobLocks.delete(jobId);
  detachClientJob(jobId, ctx);

  // Release all job resources (concurrency, uniqueKey, groupId)
  shard.releaseJobResources(job.queue, job.uniqueKey, job.groupId, job.id);

  // Discard cron jobs with preventOverlap instead of re-queuing (#73).
  // The cron scheduler will re-create them at the next scheduled tick.
  // Re-queuing them causes the "starts right away on reconnect" bug.
  if (job.uniqueKey?.startsWith('cron:')) {
    ctx.jobIndex.delete(jobId);
    ctx.storage?.deleteJob(jobId);
    return 1;
  }

  // Reset job state for retry
  job.startedAt = null;
  job.lastHeartbeat = now;

  // Re-queue the job
  shard.getQueue(job.queue).push(job);
  const isDelayed = job.runAt > now;
  shard.incrementQueued(jobId, isDelayed, job.createdAt, job.queue, job.runAt);
  ctx.jobIndex.set(jobId, { type: 'queue', shardIdx: queueShardIdx, queueName: job.queue });

  return 1;
}
