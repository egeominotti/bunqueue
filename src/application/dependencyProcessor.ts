/**
 * Dependency Processor - Job dependency resolution
 * Uses reverse index for O(m) where m = jobs waiting on completed deps
 */

import type { Job, JobId } from '../domain/types/job';
import { MAX_TIMELINE_ENTRIES } from '../domain/types/job';
import { SHARD_COUNT } from '../shared/hash';
import { withWriteLock } from '../shared/lock';
import type { BackgroundContext } from './types';
import {
  hasUnfinishedDependency,
  isDependencyComplete,
  loadColdDependencyCompletions,
  releaseDependencyCompletionPins,
} from './dependencyCompletions';

type DependencyReadyState = 'delayed' | 'prioritized' | 'waiting';

export function dependencyReadyState(job: Job, now: number): DependencyReadyState {
  if (job.runAt > now) return 'delayed';
  return job.priority > 0 ? 'prioritized' : 'waiting';
}

export function checkpointDependencyPromotion(
  job: Job,
  state: DependencyReadyState,
  now: number,
  storage: BackgroundContext['storage']
): void {
  const transition =
    job.timeline.at(-1)?.state !== state && job.timeline.length < MAX_TIMELINE_ENTRIES
      ? { state, timestamp: now }
      : undefined;
  if (storage) {
    storage.updateFlowParentResolution(
      {
        id: job.id,
        dependsOn: job.dependsOn,
        runAt: job.runAt,
        priority: job.priority,
        timeline: transition ? [...job.timeline, transition] : job.timeline,
      },
      state
    );
  }
  if (transition) job.timeline.push(transition);
}

/**
 * Process pending dependency checks
 * Resolves jobs whose dependencies have been completed
 */
export async function processPendingDependencies(ctx: BackgroundContext): Promise<void> {
  if (ctx.pendingDepChecks.size === 0) return;

  const completedIds = Array.from(ctx.pendingDepChecks);
  ctx.pendingDepChecks.clear();

  const jobsToCheckByShard = new Map<number, Set<JobId>>();
  // A previous attempt may have promoted every waiter but failed to release its pin.
  const releasedDependencyIds = new Set<JobId>(completedIds);

  // Find all jobs waiting for the completed dependencies
  for (const completedId of completedIds) {
    for (let i = 0; i < SHARD_COUNT; i++) {
      const waitingJobIds = ctx.shards[i].getJobsWaitingFor(completedId);
      if (waitingJobIds && waitingJobIds.size > 0) {
        let shardJobs = jobsToCheckByShard.get(i);
        if (!shardJobs) {
          shardJobs = new Set();
          jobsToCheckByShard.set(i, shardJobs);
        }
        for (const jobId of waitingJobIds) {
          shardJobs.add(jobId);
        }
      }
    }
  }

  // Process each shard in parallel
  // Lock acquired BEFORE reading waitingDeps to prevent TOCTOU race
  const outcomes = await Promise.allSettled(
    Array.from(jobsToCheckByShard.entries()).map(async ([i, jobIdsToCheck]) => {
      await withWriteLock(ctx.shardLocks[i], () => {
        const shard = ctx.shards[i];
        const waiting: Job[] = [];
        for (const jobId of jobIdsToCheck) {
          const job = shard.waitingDeps.get(jobId);
          if (job && (!ctx.storage || !hasUnfinishedDependency(job.dependsOn, ctx)))
            waiting.push(job);
        }
        // A notification wakes this check. A retry or ID reuse may already have retired it.
        const stored = ctx.storage
          ? loadColdDependencyCompletions(
              waiting.flatMap((job) => job.dependsOn),
              ctx
            )
          : undefined;
        const jobsToPromote = waiting.filter((job) =>
          job.dependsOn.every((dep) => isDependencyComplete(dep, ctx, stored))
        );

        // Promote jobs with all dependencies satisfied
        if (jobsToPromote.length > 0) {
          promoteJobsToQueue(jobsToPromote, shard, ctx, i, releasedDependencyIds);
        }
      });
    })
  );

  try {
    releaseDependencyCompletionPins(releasedDependencyIds, ctx);
    const failed = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failed) throw failed.reason;
  } catch (error) {
    // Reverse edges identify the remaining waiters, even after partial shard success.
    for (const id of releasedDependencyIds) ctx.pendingDepChecks.add(id);
    throw error;
  }
}

/** Move jobs from waitingDeps to the active queue */
function promoteJobsToQueue(
  jobsToPromote: Job[],
  shard: BackgroundContext['shards'][number],
  ctx: BackgroundContext,
  shardIdx: number,
  releasedDependencyIds: Set<JobId>
): void {
  const now = Date.now();

  const promoted: Job[] = [];
  try {
    for (const job of jobsToPromote) {
      const state = dependencyReadyState(job, now);
      checkpointDependencyPromotion(job, state, now, ctx.storage);
      shard.waitingDeps.delete(job.id);
      shard.unregisterDependencies(job.id, job.dependsOn);
      for (const dependencyId of job.dependsOn) releasedDependencyIds.add(dependencyId);
      shard.getQueue(job.queue).push(job);
      const isDelayed = state === 'delayed';
      shard.incrementQueued(job.id, isDelayed, job.createdAt, job.queue, job.runAt);
      ctx.jobIndex.set(job.id, { type: 'queue', shardIdx, queueName: job.queue });
      promoted.push(job);
    }
  } finally {
    // A later checkpoint failure must still wake workers for the committed prefix.
    notifyPromoted(promoted, shard, ctx);
  }
}

function notifyPromoted(
  promoted: Job[],
  shard: BackgroundContext['shards'][number],
  ctx: BackgroundContext
): void {
  if (promoted.length === 0) return;
  const promotedByQueue = new Map<string, number>();
  for (const job of promoted) {
    promotedByQueue.set(job.queue, (promotedByQueue.get(job.queue) ?? 0) + 1);
  }
  for (const [queue, count] of promotedByQueue) shard.notifyBatch(queue, count);
  for (const job of promoted) {
    ctx.dashboardEmit?.('job:dependencies-resolved', { jobId: String(job.id), queue: job.queue });
  }
}
