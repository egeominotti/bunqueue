/**
 * Cancel: remove a pending job (waiting, delayed, prioritized, waiting-children) or a
 * completed one. Active and failed jobs are never removed by Cancel.
 * See docs/features/job-lifecycle.md ("Removing a job").
 */

import type { JobId } from '../../domain/types/job';
import { EventType } from '../../domain/types/queue';
import { withWriteLock } from '../../shared/lock';
import { releaseDependencyCompletionPins } from '../dependencyCompletions';
import { removeCompletedJob } from './completedRemoval';
import type { JobManagementContext } from './jobManagement';

/** Cancel a job: false when it does not exist or is in a state Cancel does not remove. */
export async function cancelJob(jobId: JobId, ctx: JobManagementContext): Promise<boolean> {
  const location = ctx.jobIndex.get(jobId);
  if (location?.type === 'queue') return cancelPendingJob(jobId, location, ctx);
  if (location === undefined || location.type === 'completed') {
    return removeCompletedJob(jobId, ctx);
  }
  return false;
}

async function cancelPendingJob(
  jobId: JobId,
  location: { shardIdx: number; queueName: string },
  ctx: JobManagementContext
): Promise<boolean> {
  const result = await withWriteLock(ctx.shardLocks[location.shardIdx], () => {
    const shard = ctx.shards[location.shardIdx];
    const job = shard.getQueue(location.queueName).remove(jobId);
    if (job) {
      // Update running counters for O(1) stats
      shard.decrementQueued(jobId);
      if (job.uniqueKey) {
        shard.releaseUniqueKeyIfOwned(location.queueName, job.uniqueKey, job.id);
      }
      ctx.jobIndex.delete(jobId);
      ctx.storage?.deleteJob(jobId);
      ctx.dependencyResults.releaseConsumer(jobId);
      return { success: true, queueName: location.queueName, released: [] };
    }
    // Not in the run queue — it may be parked in waitingChildren (moved via
    // moveToWaitingChildren, which already released its resources and does not
    // track it in the queued counter, so do NOT decrement/release here).
    const parked = shard.waitingChildren.get(jobId);
    if (parked) {
      shard.waitingChildren.delete(jobId);
      ctx.jobIndex.delete(jobId);
      ctx.storage?.deleteJob(jobId);
      ctx.dependencyResults.releaseConsumer(jobId);
      return { success: true, queueName: location.queueName, released: [] };
    }
    // Or parked in waitingDeps (flow-chain dependent inserted by push.ts while
    // its predecessors are unresolved). These are NOT counted in the queued
    // counter (insertJobToShard skips incrementQueued when needsWaiting), so do
    // NOT decrement — but they DO hold their uniqueKey reservation and register
    // entries in the dependency index, both of which must be released here.
    const waiting = shard.waitingDeps.get(jobId);
    if (waiting) {
      shard.waitingDeps.delete(jobId);
      shard.unregisterDependencies(jobId, waiting.dependsOn);
      if (waiting.uniqueKey) {
        shard.releaseUniqueKeyIfOwned(location.queueName, waiting.uniqueKey, waiting.id);
      }
      ctx.jobIndex.delete(jobId);
      ctx.storage?.deleteJob(jobId);
      ctx.dependencyResults.releaseConsumer(jobId);
      return {
        success: true,
        queueName: location.queueName,
        released: waiting.dependsOn,
      };
    }
    return { success: false, queueName: location.queueName, released: [] };
  });

  if (result.success) {
    releaseDependencyCompletionPins(result.released, ctx);
    // Emit removed event (BullMQ v5)
    ctx.eventsManager.broadcast({
      eventType: EventType.Removed,
      jobId,
      queue: result.queueName,
      timestamp: Date.now(),
      prev: 'waiting',
    });
  }
  return result.success;
}
