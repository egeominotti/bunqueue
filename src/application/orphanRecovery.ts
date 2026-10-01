/**
 * Orphan Recovery - cleanup's backstop for the stall checker.
 *
 * An orphan is an active job that has shown no liveness for longer than both
 * a 30-minute floor and its own stall window, on a queue whose stall detection
 * is enabled. It is recovered through the stall path, so anything recovered
 * here the stall checker would also consider stalled. One difference: like lock
 * expiration and startup recovery, it treats `maxStalls: 0` as unlimited,
 * while the stall checker sends a job to the DLQ on its first stall.
 */

import type { Job, JobLock } from '../domain/types/job';
import { isLeaseFromEarlierGeneration, isLockExpired } from '../domain/types/job';
import { StallAction } from '../domain/types/stall';
import { shardIndex, SHARD_COUNT } from '../shared/hash';
import { queueLog } from '../shared/logger';
import type { BackgroundContext } from './types';
import { handleStalledJob } from './stallDetection';

/** The shortest silence after which an active job can be an orphan. */
export const ORPHAN_WINDOW_FLOOR_MS = 30 * 60 * 1000;

/**
 * A processing entry is an orphan only when its queue has stall detection
 * enabled and it has shown no liveness for the whole window: the larger of
 * the 30-minute floor and the job's own stall window (`job.stallTimeout`, else
 * the queue's `stallInterval`, as the stall checker reads them). Disabled
 * queues are skipped entirely: disabling stall detection opts the queue out
 * of every heartbeat-based recovery. The job must also be past the queue's
 * `gracePeriod`, again as the stall checker requires.
 *
 * Pull, token-less heartbeats, progress updates and lock renewals all refresh
 * `lastHeartbeat`, so silence is measured from the latest of `startedAt` and
 * `lastHeartbeat`. An unexpired lock lease of the current processing
 * generation is ownership granted to a worker; lock expiration, not this
 * sweep, decides when it lapses. A lease left from an earlier generation
 * (stall retry keeps it as a stale-outcome guard) says nothing about the
 * current one, so it is ignored by the same rule `createLock` uses.
 * Entries without `startedAt` are never orphans here.
 */
function isOrphanedProcessingEntry(
  job: Job,
  lock: JobLock | undefined,
  now: number,
  ctx: BackgroundContext
): boolean {
  if (!job.startedAt) return false;
  const config = ctx.shards[shardIndex(job.queue)].getStallConfig(job.queue);
  if (!config.enabled) return false;
  if (now - job.startedAt < config.gracePeriod) return false;
  if (lock && !isLockExpired(lock, now) && !isLeaseFromEarlierGeneration(job, lock)) return false;
  const window = Math.max(ORPHAN_WINDOW_FLOOR_MS, job.stallTimeout ?? config.stallInterval);
  const lastActivity = Math.max(job.startedAt, job.lastHeartbeat || 0);
  return now - lastActivity > window;
}

/**
 * An orphan consumes one stall, counted like lock expiry and startup recovery:
 * reaching a positive `maxStalls` sends it to the DLQ (0 means unlimited).
 * `handleStalledJob` additionally moves it to the DLQ when attempts run out.
 */
function orphanStallAction(job: Job, ctx: BackgroundContext): StallAction {
  const { maxStalls } = ctx.shards[shardIndex(job.queue)].getStallConfig(job.queue);
  return maxStalls > 0 && job.stallCount + 1 >= maxStalls
    ? StallAction.MoveToDlq
    : StallAction.Retry;
}

/**
 * An orphan is a stalled job the stall checker did not reclaim (for example
 * its recovery attempt failed on a lock timeout), so it takes the stall
 * recovery path: concurrency, group and unique-key resources are released,
 * the attempt is counted, client ownership is detached, and the job is retried
 * with backoff or moved to the DLQ, persisted and announced like any stalled
 * job. `handleStalledJob` holds `shardLocks` then `processingLocks`, confirms
 * the same job object is still processing, and only then re-runs this whole
 * predicate (configuration included), because a heartbeat, progress update,
 * lock renewal or stall-config change can land while the sweep waits.
 */
export async function recoverOrphanedProcessingEntries(
  ctx: BackgroundContext,
  now: number
): Promise<void> {
  // Phase 1: collect candidates (read-only, no lock needed)
  const orphans: Job[] = [];
  for (let i = 0; i < SHARD_COUNT; i++) {
    for (const [jobId, job] of ctx.processingShards[i]) {
      if (isOrphanedProcessingEntry(job, ctx.jobLocks.get(jobId), now, ctx)) {
        orphans.push(job);
      }
    }
  }
  if (orphans.length === 0) return;

  // Phase 2: recover each one through the stall path, re-checked under its locks.
  const stillOrphaned = (job: Job, lockedNow: number): boolean =>
    isOrphanedProcessingEntry(job, ctx.jobLocks.get(job.id), lockedNow, ctx);
  let recovered = 0;
  for (const job of orphans) {
    try {
      if (await handleStalledJob(job, orphanStallAction(job, ctx), ctx, stillOrphaned)) {
        recovered++;
      }
    } catch (err: unknown) {
      // Logged like stall detection; an entry still in processing is retried next tick.
      queueLog.error('Failed to recover orphaned processing entry', {
        jobId: String(job.id),
        error: String(err),
      });
    }
  }
  if (recovered > 0) ctx.dashboardEmit?.('cleanup:orphans-removed', { count: recovered });
}
