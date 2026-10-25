/**
 * Atomic queue-state transitions used by single and batch pull orchestration.
 */

import type { Shard } from '../../domain/queue/shard';
import {
  type Job,
  type JobId,
  isExpired,
  isReady,
  MAX_TIMELINE_ENTRIES,
} from '../../domain/types/job';
import type { GroupPullOptions } from '../../domain/types/group';
import type { EventType, JobEvent, JobLocation } from '../../domain/types/queue';
import type { SqliteStorage } from '../../infrastructure/persistence/sqlite';
import { processingShardIndex } from '../../shared/hash';
import type { RWLock } from '../../shared/lock';
import { withWriteLock } from '../../shared/lock';
import { queueLog } from '../../shared/logger';
import { persistRelease } from './releasePersistence';

/** Dependencies shared by the single and batch pull paths. */
export interface PullContext {
  storage: SqliteStorage | null;
  shards: Shard[];
  shardLocks: RWLock[];
  processingShards: Map<JobId, Job>[];
  processingLocks: RWLock[];
  jobIndex: Map<JobId, JobLocation>;
  totalPulled: { value: bigint };
  broadcast: (event: {
    eventType: EventType;
    queue: string;
    jobId: JobId;
    timestamp: number;
  }) => void;
  broadcastBatch?: (events: readonly JobEvent[]) => void;
  dashboardEmit?: (event: string, data: Record<string, unknown>) => void;
}

export interface DequeueScan {
  parked: Job[];
  nextRunAt: number | null;
  groupOptions?: GroupPullOptions;
}

export type DequeueResult = { status: 'job'; job: Job } | { status: 'stop' };

export function createDequeueScan(groupOptions?: GroupPullOptions): DequeueScan {
  return { parked: [], nextRunAt: null, groupOptions };
}

/** Restore physical heap membership without changing logical queue state. */
export function restoreParkedJobs(shard: Shard, queue: string, scan: DequeueScan): void {
  const priorityQueue = shard.getQueue(queue);
  for (const job of scan.parked) priorityQueue.push(job);
  scan.parked.length = 0;
}

/**
 * Remove the best eligible job from the shard's secondary group indexes.
 * A batch reuses the same fixed timestamp and group defaults while its
 * synchronous shard critical section is held.
 */
export function tryDequeueNextJob(
  shard: Shard,
  queue: string,
  now: number,
  ctx: PullContext,
  scan: DequeueScan
): DequeueResult {
  const priorityQueue = shard.getQueue(queue);

  if (!shard.hasGroupScheduler(queue)) {
    // Nothing can be ready or expired: the scan below would park every job and stop
    // with their earliest runAt, so answer that directly.
    const idleRunAt = shard.idleRunAt(queue, now);
    if (idleRunAt !== undefined) {
      if (idleRunAt !== null) {
        scan.nextRunAt = scan.nextRunAt === null ? idleRunAt : Math.min(scan.nextRunAt, idleRunAt);
      }
      return { status: 'stop' };
    }
  }

  while (true) {
    const grouped = shard.hasGroupScheduler(queue);
    const candidate = grouped
      ? shard.peekGroupCandidate(queue, now, scan.groupOptions)
      : { job: priorityQueue.peek(), nextRunAt: null };
    if (grouped) scan.nextRunAt = candidate.nextRunAt;
    const job = candidate.job;
    if (!job) {
      if (!grouped) shard.markExhausted(queue);
      return { status: 'stop' };
    }

    if (isExpired(job, now)) {
      // Persistence is removed first so a failed durable delete leaves the
      // in-memory job available for a later attempt.
      ctx.storage?.deleteJob(job.id);
      if (grouped) priorityQueue.remove(job.id);
      else priorityQueue.pop();
      shard.decrementQueued(job.id);
      ctx.jobIndex.delete(job.id);
      ctx.dashboardEmit?.('job:expired', {
        queue,
        jobId: String(job.id),
        ttl: job.ttl,
        age: now - job.createdAt,
      });
      continue;
    }

    if (!grouped && !isReady(job, now)) {
      const delayed = priorityQueue.pop();
      if (delayed) scan.parked.push(delayed);
      scan.nextRunAt = scan.nextRunAt === null ? job.runAt : Math.min(scan.nextRunAt, job.runAt);
      continue;
    }

    // Capacity is consumed only after an eligible job has been found. The slot is
    // held by this job id: the job's release frees exactly this slot.
    if (!shard.tryAcquireConcurrency(queue, job.id)) {
      ctx.dashboardEmit?.('concurrency:rejected', { queue });
      return { status: 'stop' };
    }
    if (!shard.tryAcquireRateLimit(queue)) {
      shard.releaseConcurrency(queue, job.id);
      ctx.dashboardEmit?.('ratelimit:rejected', { queue });
      return { status: 'stop' };
    }

    if (job.groupId && !shard.acquireGroup(queue, job.groupId, job.id, scan.groupOptions, now)) {
      shard.releaseConcurrency(queue, job.id);
      return { status: 'stop' };
    }

    const dequeued = grouped ? priorityQueue.remove(job.id) : priorityQueue.pop();
    if (dequeued?.id !== job.id) {
      // The slots above are held under the candidate's id, so they go back with it.
      // peek() and pop() agree while the shard lock is held; should they ever differ,
      // the popped job was never checked (expiry, readiness, group, limits), so it is
      // neither activated nor re-keyed onto the candidate's slots: it returns to the
      // queue unchanged (its queued counters were never decremented) and this pull
      // stops, loudly, rather than strand a slot or run an unchecked job.
      if (job.groupId) shard.releaseGroup(queue, job.groupId, job.id);
      shard.releaseConcurrency(queue, job.id);
      if (dequeued) {
        priorityQueue.push(dequeued);
        queueLog.error('Pull candidate and dequeued job differ; job returned to the queue', {
          queue,
          candidate: String(job.id),
          dequeued: String(dequeued.id),
        });
      }
      return { status: 'stop' };
    }
    shard.decrementQueued(dequeued.id);

    if (dequeued.groupId) shard.advanceGroup(queue, dequeued.groupId);

    dequeued.startedAt = now;
    dequeued.lastHeartbeat = now;
    if (dequeued.timeline.length < MAX_TIMELINE_ENTRIES) {
      dequeued.timeline.push({ state: 'active', timestamp: now });
    }

    // Queue -> processing is atomic for observers while the shard lock is held.
    const procIdx = processingShardIndex(dequeued.id);
    ctx.processingShards[procIdx].set(dequeued.id, dequeued);
    ctx.jobIndex.set(dequeued.id, { type: 'processing', shardIdx: procIdx, queueName: queue });

    return { status: 'job', job: dequeued };
  }
}

/** Restore a dequeued job when its handoff to the worker cannot complete. */
export async function requeueJob(
  job: Job,
  queue: string,
  idx: number,
  ctx: PullContext
): Promise<void> {
  const procIdx = processingShardIndex(job.id);
  let requeued = false;

  await withWriteLock(ctx.shardLocks[idx], () => {
    if (!ctx.processingShards[procIdx].has(job.id)) return;
    const shard = ctx.shards[idx];
    if (job.groupId) shard.releaseGroup(queue, job.groupId, job.id);
    shard.releaseConcurrency(queue, job.id);
    // The job never reached a worker: drop the `active` entry this dequeue appended
    // (same timestamp as `startedAt`; none is appended once the timeline is full).
    const last = job.timeline.at(-1);
    if (last?.state === 'active' && last.timestamp === job.startedAt) job.timeline.pop();
    job.startedAt = null;
    shard.getQueue(queue).push(job);
    shard.incrementQueued(job.id, false, job.createdAt, queue, job.runAt);
    ctx.jobIndex.set(job.id, { type: 'queue', shardIdx: idx, queueName: queue });
    // A failed handoff may already have stored the job `active`; store it queued again
    // before the shard lock is released, so startup recovery never charges it.
    persistRelease(job, ctx.storage);
    shard.notify(queue);
    requeued = true;
  });

  if (!requeued) return;

  await withWriteLock(ctx.processingLocks[procIdx], () => {
    // A concurrent pull may already have moved the same object back to active.
    if (ctx.jobIndex.get(job.id)?.type !== 'processing') {
      ctx.processingShards[procIdx].delete(job.id);
    }
  });
}
