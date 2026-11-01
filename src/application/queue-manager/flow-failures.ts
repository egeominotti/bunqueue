import type { Shard } from '../../domain/queue/shard';
import type { DlqEntry } from '../../domain/types/dlq';
import { FailureReason } from '../../domain/types/dlq';
import type { FlowFailureRecord } from '../../domain/types/flow';
import type { Job, JobId } from '../../domain/types/job';
import type { JobLocation } from '../../domain/types/queue';
import { EventType } from '../../domain/types/queue';
import { shardIndex } from '../../shared/hash';
import { withWriteLock } from '../../shared/lock';
import type { SetLike } from '../../shared/lru';
import { failedByChildMessage } from '../../domain/job/flowFailureMessage';
import {
  emitFlowChildFailed,
  flowFailureRecord,
  persistRecoveryDlqMove,
} from '../flowChildFailure';
import { QueueManagerDependencyRuntime } from './dependency-runtime';

/** A parent moved to the DLQ by its child, with its own policy record (if any). */
interface FailedFlowParent {
  readonly parent: Job;
  readonly error: string;
  readonly flowFailure: FlowFailureRecord | null;
}

/** Settles like `queryOps.getJob` for a job it finds without awaiting a lock. */
async function settledJob(job: Job): Promise<Job> {
  return job;
}

/** Same promise shape as `getJob`: an async method that returns an async lookup. */
async function retainedLookup(job: Job): Promise<Job> {
  return settledJob(job);
}

export class QueueManagerFlowFailures extends QueueManagerDependencyRuntime {
  protected onDlqEvicted(entry: DlqEntry): void {
    const location = this.jobIndex.get(entry.job.id);
    const ownsTerminal =
      location === undefined || (location.type === 'dlq' && location.queueName === entry.job.queue);
    if (ownsTerminal) {
      this.jobIndex.delete(entry.job.id);
      this.jobResults.delete(entry.job.id);
      this.jobResultQueues.delete(entry.job.id);
      this.jobLogs.delete(entry.job.id);
      this.jobLogQueues.delete(entry.job.id);
      this.dependencyResults.releaseConsumer(entry.job.id);
      if (entry.job.customId && this.customIdMap.get(entry.job.customId) === entry.job.id) {
        this.customIdMap.delete(entry.job.customId);
      }
    }
    this.storage?.purgeDlqEntries(
      entry.job.queue,
      [entry.job.id],
      ownsTerminal ? [entry.job.id] : [],
      false
    );
  }

  getJobIndex(): Map<JobId, JobLocation> {
    return this.jobIndex;
  }

  getCompletedJobs(): SetLike<JobId> {
    return this.completedJobs;
  }

  getDepCompletions(): SetLike<JobId> {
    return this.depCompletions;
  }

  getShards(): Shard[] {
    return this.shards;
  }

  protected onJobCompleted(completedId: JobId): void {
    this.failedChildrenValues.delete(completedId);
    this.ignoredChildrenFailures.delete(completedId);
    this.storage?.deleteFlowFailure(completedId);
    this.pendingDepChecks.add(completedId);
    this.scheduleDependencyFlush();
    void this.checkFlowCompleted(completedId);
  }

  protected onJobFailed(failedId: JobId): void {
    this.failedChildrenValues.delete(failedId);
    this.ignoredChildrenFailures.delete(failedId);
    this.storage?.deleteFlowFailure(failedId);
  }

  protected async checkFlowCompleted(completedId: JobId): Promise<void> {
    // The completion that called us just retained this job in memory: read it there
    // instead of decoding the row it wrote to SQLite. `retainedLookup` settles on the
    // same microtask as `getJob`, so dashboard events keep their order.
    const retained =
      this.jobIndex.get(completedId)?.type === 'completed'
        ? this.completedJobsData.get(completedId)
        : undefined;
    const job = await (retained ? retainedLookup(retained) : this.getJob(completedId));
    if (!job?.parentId) return;
    const parent = await this.getJob(job.parentId);
    if (!parent?.childrenIds || parent.childrenIds.length === 0) return;
    if (parent.childrenIds.every((childId) => this.completedJobs.has(childId))) {
      this.dashboardEmit?.('flow:completed', {
        parentJobId: String(parent.id),
        queue: parent.queue,
        childrenCount: parent.childrenIds.length,
      });
    }
  }

  protected async failParentOnChildFailure(
    childJob: Job,
    error: string | undefined
  ): Promise<void> {
    if (childJob.parentId) await this.moveParentToFailed(childJob.parentId, childJob, error);
  }

  /**
   * Fail a flow parent because of a child's `failParentOnFailure`. The parent has then
   * failed terminally itself, so its own flow policy applies to its parent in turn, up
   * the tree. Iterative with a visited set: a cycle or a deep chain cannot recurse.
   */
  protected override async moveParentToFailed(
    parentId: JobId,
    childJob: Job,
    error: string | undefined
  ): Promise<void> {
    const visited = new Set<JobId>();
    let next: { parentId: JobId; child: Job; error: string | undefined } | null = {
      parentId,
      child: childJob,
      error,
    };
    while (next && !visited.has(next.parentId)) {
      visited.add(next.parentId);
      const failed = await this.failParentForChild(next.parentId, next.child, next.error);
      next = null;
      if (!failed?.flowFailure) break;
      // Every lock is released here, as after a worker FAIL.
      const { parent, error: parentError } = failed;
      if (failed.flowFailure.mode === 'fail') {
        next = { parentId: failed.flowFailure.parentId, child: parent, error: parentError };
      } else {
        await this.onChildDependencyOption(parent, parentError);
      }
    }
  }

  /** Move one parent to the DLQ; returns it with its own policy record, or null. */
  private async failParentForChild(
    parentId: JobId,
    childJob: Job,
    error: string | undefined
  ): Promise<FailedFlowParent | null> {
    const parentJob = await this.getJob(parentId);
    if (!parentJob || this.jobIndex.get(parentId)?.type !== 'queue') return null;

    const index = shardIndex(parentJob.queue);
    const failError = failedByChildMessage(String(childJob.id), error ?? 'unknown error');
    let releasedDependencies: JobId[] = [];
    let failed: FailedFlowParent | null = null;
    await withWriteLock(this.shardLocks[index], () => {
      if (this.jobIndex.get(parentId)?.type !== 'queue') return;
      const shard = this.shards[index];
      if (shard.waitingDeps.has(parentId)) {
        releasedDependencies = [...parentJob.dependsOn];
        shard.waitingDeps.delete(parentId);
        shard.unregisterDependencies(parentId, parentJob.dependsOn);
      }
      shard.waitingChildren.delete(parentId);
      const queue = shard.getQueue(parentJob.queue);
      if (queue.find(parentId)) {
        queue.remove(parentId);
        shard.decrementQueued(parentId);
      }
      const entry = shard.addToDlq(parentJob, FailureReason.Unknown, failError);
      this.jobIndex.set(parentId, { type: 'dlq', queueName: parentJob.queue });
      // A parent with its own policy commits that outbox record with its DLQ move.
      const flowFailure = flowFailureRecord(parentJob, failError);
      persistRecoveryDlqMove(this.storage, parentId, entry, flowFailure);
      this.storage?.deleteFlowFailure(parentId, childJob.id);
      failed = { parent: parentJob, error: failError, flowFailure };
    });
    const result = failed as FailedFlowParent | null;
    // A sibling (or any other transition) moved the parent first: that call owns its
    // terminal failure, so this one emits nothing and leaves its bookkeeping alone.
    if (!result) return null;
    this.releaseCompletionPins(releasedDependencies);
    this.failedChildrenValues.delete(parentId);
    this.ignoredChildrenFailures.delete(parentId);
    this.dependencyResults.releaseConsumer(parentId);
    this.eventsManager.broadcast({
      eventType: EventType.Failed,
      queue: parentJob.queue,
      jobId: parentId,
      timestamp: Date.now(),
      error: failError,
      data: parentJob.data,
    });
    this.dashboardEmit?.('flow:failed', {
      parentJobId: String(parentId),
      failedChildId: String(childJob.id),
      queue: parentJob.queue,
      error: error ?? 'Child job failed',
    });
    if (result.flowFailure) {
      emitFlowChildFailed(this.dashboardEmit ?? undefined, parentJob, failError);
    }
    return result;
  }
}
