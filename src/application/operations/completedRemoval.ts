/**
 * Cancel of a completed job (`job.remove()`, `queue.removeAsync()`, issue #155).
 *
 * The end state is exactly what `removeOnComplete` would have produced when the job
 * completed: the job row, its result and every in-memory projection are gone, while the
 * payload-free completion proof (`dependency_completions`, with the original completion
 * time, pinned while dependents wait) stays so dependents still resolve. One SQLite
 * transaction deletes the row and the result and writes the proof, before any memory is
 * changed, so a crash or a failed write cannot resurrect the job or lose the proof.
 */

import type { Job, JobId } from '../../domain/types/job';
import { type JobLocation, EventType } from '../../domain/types/queue';
import type { Shard } from '../../domain/queue/shard';
import type { SqliteStorage } from '../../infrastructure/persistence/sqlite';
import { shardIndex } from '../../shared/hash';
import { type RWLock, withWriteLock } from '../../shared/lock';
import { releaseCompletedProjections } from '../completedCleanup';
import {
  commitRemovedCompletion,
  type DependencyCompletionTracker,
} from '../dependencyCompletions';
import type { DependencyResultTracker } from '../dependencyResultTracker';
import type { EventsManager } from '../eventsManager';

export interface CompletedRemovalContext {
  storage: SqliteStorage | null;
  shards: Shard[];
  shardLocks: RWLock[];
  jobIndex: Map<JobId, JobLocation>;
  completedJobs: { delete(jobId: JobId): boolean };
  completedJobsData: { get(jobId: JobId): Job | undefined; delete(jobId: JobId): boolean };
  jobResults: {
    has(jobId: JobId): boolean;
    get(jobId: JobId): unknown;
    delete(jobId: JobId): boolean;
  };
  jobResultQueues: { get(jobId: JobId): string | undefined; delete(jobId: JobId): boolean };
  jobLogs: { delete(jobId: JobId): boolean };
  jobLogQueues: { get(jobId: JobId): string | undefined; delete(jobId: JobId): boolean };
  dependencyResults: DependencyResultTracker;
  depCompletions?: DependencyCompletionTracker;
  maxDependencyCompletions: number;
  eventsManager: EventsManager;
}

interface CompletedGeneration {
  readonly queue: string;
  readonly completedAt: number;
}

function completionTime(job: Job | null | undefined): number {
  return job?.completedAt ?? job?.createdAt ?? Date.now();
}

/** The completed generation currently owning `jobId`, or null when there is none. */
function completedGeneration(
  jobId: JobId,
  ctx: CompletedRemovalContext
): CompletedGeneration | null {
  const location = ctx.jobIndex.get(jobId);
  if (location) {
    if (location.type !== 'completed') return null;
    const job = ctx.completedJobsData.get(jobId) ?? ctx.storage?.getCompletedJob(jobId);
    if (job && job.queue !== location.queueName) return null;
    return { queue: location.queueName, completedAt: completionTime(job) };
  }
  // The bounded completedJobs set evicted the generation from memory, or a restart did
  // not load it; SQLite still keeps it and getJobState still reports it completed.
  const storage = ctx.storage;
  if (!storage || storage.getBufferedJob(jobId) || storage.hasDlqEntry(jobId)) return null;
  const job = storage.getCompletedJob(jobId);
  return job ? { queue: job.queue, completedAt: completionTime(job) } : null;
}

/**
 * A live dependency consumer keeps reading the result through `dependencyResults`, as it
 * does for a `removeOnComplete` dependency; retain it before the stored copy is deleted
 * when the consumer was registered after the result left the bounded result cache.
 */
function retainForLiveConsumers(jobId: JobId, queue: string, ctx: CompletedRemovalContext): void {
  if (!ctx.dependencyResults.hasConsumers(jobId) || ctx.dependencyResults.has(jobId)) return;
  let result: unknown;
  if (ctx.jobResultQueues.get(jobId) === queue && ctx.jobResults.has(jobId)) {
    result = ctx.jobResults.get(jobId);
  } else if (ctx.storage?.hasResult(jobId)) {
    result = ctx.storage.getResult(jobId);
  }
  if (result !== undefined) ctx.dependencyResults.retain(jobId, result);
}

/** Remove the completed generation of `jobId`; false when the job is not completed. */
export async function removeCompletedJob(
  jobId: JobId,
  ctx: CompletedRemovalContext
): Promise<boolean> {
  const candidate = completedGeneration(jobId, ctx);
  if (!candidate) return false;

  const removed = await withWriteLock(ctx.shardLocks[shardIndex(candidate.queue)], () => {
    // Re-read under the lock: the generation may have been retried, cleaned or replaced.
    const generation = completedGeneration(jobId, ctx);
    if (generation?.queue !== candidate.queue) return false;
    retainForLiveConsumers(jobId, generation.queue, ctx);
    commitRemovedCompletion({ id: jobId, queue: generation.queue }, ctx, generation.completedAt);
    releaseCompletedProjections(jobId, generation.queue, ctx);
    return true;
  });

  if (removed) {
    ctx.eventsManager.broadcast({
      eventType: EventType.Removed,
      jobId,
      queue: candidate.queue,
      timestamp: Date.now(),
      prev: 'completed',
    });
  }
  return removed;
}
