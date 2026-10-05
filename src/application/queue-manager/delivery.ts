import type { Job, JobId, JobInput, JobLock } from '../../domain/types/job';
import { DEFAULT_LOCK_TTL, isLeaseFromEarlierGeneration } from '../../domain/types/job';
import {
  assertLockDuration,
  normalizeJobInput,
  pullTimeoutArgument,
} from '../../domain/job/options';
import type { AtomicFlowBatchInput, AtomicFlowBatchResult } from '../../domain/types/flow';
import type { GroupPullOptions } from '../../domain/types/group';
import { EventType } from '../../domain/types/queue';
import { setDlqRetryState } from '../../domain/types/dlq';
import { withWriteLock } from '../../shared/lock';
import { pushJob, pushJobBatch } from '../operations/push';
import { withPendingQueueAdmissions } from '../operations/pushContext';
import { pushFlowBatch } from '../operations/flowPush';
import { pullJob, pullJobBatch } from '../operations/pull';
import { commitRemovedCompletion } from '../dependencyCompletions';
import * as lockMgr from '../lockManager';
import { QueueManagerState } from './state';

export class QueueManagerDelivery extends QueueManagerState {
  async push(queue: string, input: JobInput): Promise<Job> {
    const ctx = this.contextFactory.getPushContext();
    // Every caller (embedded, TCP, HTTP, cron, direct) stores the same normalized options.
    const normalized = normalizeJobInput(input);
    return withPendingQueueAdmissions([queue], ctx, () => pushJob(queue, normalized, ctx));
  }

  async pushBatch(queue: string, inputs: JobInput[]): Promise<JobId[]> {
    const ctx = this.contextFactory.getPushContext();
    const normalized = inputs.map(normalizeJobInput);
    return withPendingQueueAdmissions([queue], ctx, () => pushJobBatch(queue, normalized, ctx));
  }

  async pushFlow(batch: AtomicFlowBatchInput): Promise<AtomicFlowBatchResult> {
    return pushFlowBatch(batch, this.contextFactory.getPushContext());
  }

  async pull(
    queue: string,
    timeoutMs = 0,
    signal?: AbortSignal,
    groupOptions?: GroupPullOptions
  ): Promise<Job | null> {
    const job = await pullJob(
      queue,
      pullTimeoutArgument(timeoutMs),
      this.contextFactory.getPullContext(),
      signal,
      groupOptions
    );
    if (job) this.scheduleJobTimeout(job);
    return job;
  }

  // oxlint-disable-next-line max-params -- public API includes cancellation and lock policy
  async pullWithLock(
    queue: string,
    owner: string,
    timeoutMs = 0,
    lockTtl = DEFAULT_LOCK_TTL,
    signal?: AbortSignal,
    groupOptions?: GroupPullOptions
  ): Promise<{ job: Job | null; token: string | null }> {
    // 2.9.10's results: a wait outside 0..60 s is clamped, any finite lease is granted.
    assertLockDuration(lockTtl, 'lockTtl');
    const job = await pullJob(
      queue,
      pullTimeoutArgument(timeoutMs),
      this.contextFactory.getPullContext(),
      signal,
      groupOptions
    );
    if (!job) return { job: null, token: null };
    const token = lockMgr.createLock(job.id, owner, this.contextFactory.getLockContext(), lockTtl);
    this.scheduleJobTimeout(job);
    return { job, token };
  }

  async pullBatch(
    queue: string,
    count: number,
    timeoutMs = 0,
    signal?: AbortSignal,
    groupOptions?: GroupPullOptions
  ): Promise<Job[]> {
    const wait = pullTimeoutArgument(timeoutMs);
    const jobs = await pullJobBatch(queue, count, wait, this.contextFactory.getPullContext(), {
      signal,
      group: groupOptions,
    });
    for (const job of jobs) this.scheduleJobTimeout(job);
    return jobs;
  }

  // oxlint-disable-next-line max-params -- public API includes cancellation and lock policy
  async pullBatchWithLock(
    queue: string,
    count: number,
    owner: string,
    timeoutMs = 0,
    lockTtl = DEFAULT_LOCK_TTL,
    signal?: AbortSignal,
    groupOptions?: GroupPullOptions
  ): Promise<{ jobs: Job[]; tokens: string[] }> {
    assertLockDuration(lockTtl, 'lockTtl');
    const wait = pullTimeoutArgument(timeoutMs);
    const jobs = await pullJobBatch(queue, count, wait, this.contextFactory.getPullContext(), {
      signal,
      group: groupOptions,
    });
    const tokens = jobs.map(
      (job) =>
        lockMgr.createLock(job.id, owner, this.contextFactory.getLockContext(), lockTtl) ?? ''
    );
    for (const job of jobs) this.scheduleJobTimeout(job);
    return { jobs, tokens };
  }

  protected throwIfOwnershipConflict(
    jobId: JobId,
    lockCtx: { jobLocks: Map<JobId, JobLock> }
  ): void {
    const location = this.jobIndex.get(jobId);
    if (location?.type === 'processing' && lockCtx.jobLocks.has(jobId)) {
      throw new Error(`Invalid or expired lock token for job ${jobId}`);
    }
  }

  /** Require the exact current lease token whenever a lock record exists. */
  protected assertLeaseToken(
    jobId: JobId,
    token: string | undefined,
    lockCtx: { jobLocks: Map<JobId, JobLock> }
  ): void {
    const lock = lockCtx.jobLocks.get(jobId);
    if (!lock) return;
    if (!token) throw new Error(`Lock token required for job ${jobId}`);
    if (lock.token !== token) throw new Error(`Invalid or expired lock token for job ${jobId}`);

    const location = this.jobIndex.get(jobId);
    if (location?.type !== 'processing') return;
    const job = this.processingShards[location.shardIdx].get(jobId);
    if (!job || isLeaseFromEarlierGeneration(job, lock)) {
      throw new Error(`Invalid or expired lock token for job ${jobId}`);
    }
  }

  protected isExpiredButOwned(
    jobId: JobId,
    token: string,
    lockCtx: { jobLocks: Map<JobId, JobLock> }
  ): boolean {
    const location = this.jobIndex.get(jobId);
    if (location?.type !== 'processing') return false;
    const lock = lockCtx.jobLocks.get(jobId);
    if (lock?.token !== token) return false;
    const job = this.processingShards[location.shardIdx].get(jobId);
    return !(job && isLeaseFromEarlierGeneration(job, lock));
  }

  protected isStallRetried(jobId: JobId): boolean {
    const location = this.jobIndex.get(jobId);
    if (location?.type !== 'queue') return false;
    const job = this.shards[location.shardIdx].getQueue(location.queueName).find(jobId);
    return job !== null && job.attempts > 0;
  }

  /** Match a late outcome to the exact cron lease retired by lock expiry. */
  protected isRetiredCronOutcome(jobId: JobId, token: string | undefined): boolean {
    return (
      token !== undefined &&
      !this.jobIndex.has(jobId) &&
      this.retiredCronLeaseTokens.get(jobId) === token
    );
  }

  protected async completeStallRetriedJob(
    jobId: JobId,
    result: unknown,
    removeOnComplete?: boolean
  ): Promise<boolean> {
    const location = this.jobIndex.get(jobId);
    if (location?.type !== 'queue') return false;
    const shard = this.shards[location.shardIdx];
    let job: Job | null = null;
    await withWriteLock(this.shardLocks[location.shardIdx], () => {
      job = shard.getQueue(location.queueName).remove(jobId);
      if (job) {
        shard.decrementQueued(jobId);
        shard.releaseJobResources(location.queueName, job.uniqueKey, job.groupId, job.id);
      }
    });
    if (!job) return false;
    const completedJob = job as Job;
    const currentLocation = this.jobIndex.get(jobId);
    if (currentLocation?.type !== 'queue' || currentLocation.queueName !== completedJob.queue) {
      return false;
    }

    setDlqRetryState(completedJob, null);
    const ctx = this.contextFactory.getAckContext();
    if (!(completedJob.removeOnComplete || removeOnComplete === true)) {
      ctx.completedJobs.add(jobId);
      ctx.completedJobsData.set(jobId, completedJob);
      if (result !== undefined) {
        ctx.jobResults.set(jobId, result);
        ctx.jobResultQueues.set(jobId, completedJob.queue);
        ctx.storage?.storeResult(jobId, result);
      }
      ctx.jobIndex.set(jobId, { type: 'completed', queueName: completedJob.queue });
      ctx.storage?.markCompleted(jobId, Date.now(), completedJob.timeline);
    } else {
      commitRemovedCompletion(completedJob, ctx);
      ctx.jobIndex.delete(jobId);
    }
    if (result !== undefined) ctx.dependencyResults.retain(jobId, result);
    ctx.dependencyResults.releaseConsumer(jobId);
    ctx.totalCompleted.value++;
    ctx.broadcast({
      eventType: EventType.Completed,
      queue: location.queueName,
      jobId,
      timestamp: Date.now(),
      data: result,
    });
    ctx.onJobCompleted(jobId);
    return true;
  }
}
