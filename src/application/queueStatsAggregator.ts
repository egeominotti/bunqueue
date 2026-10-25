import { SHARD_COUNT, shardIndex } from '../shared/hash';
import type { StatsContext } from './types';

export interface PerQueueStats {
  waiting: number;
  prioritized: number;
  delayed: number;
  active: number;
  dlq: number;
}

export interface QueueJobCounts {
  waiting: number;
  prioritized: number;
  delayed: number;
  active: number;
  completed: number;
  failed: number;
  'waiting-children': number;
  totalCompleted: number;
  totalFailed: number;
}

function createCounts(queue: string, ctx: StatsContext): QueueJobCounts {
  const metrics = ctx.perQueueMetrics?.get(queue);
  return {
    waiting: 0,
    prioritized: 0,
    delayed: 0,
    active: 0,
    completed: 0,
    failed: ctx.shards[shardIndex(queue)].getDlqCount(queue),
    'waiting-children': 0,
    totalCompleted: Number(metrics?.totalCompleted ?? 0n),
    totalFailed: Number(metrics?.totalFailed ?? 0n),
  };
}

/** Aggregate all requested queues in one pass over every global collection. */
export function getAllQueueJobCounts(
  queueNames: Iterable<string>,
  ctx: StatsContext
): Map<string, QueueJobCounts> {
  const result = new Map<string, QueueJobCounts>();
  const now = Date.now();

  for (const name of queueNames) {
    const counts = createCounts(name, ctx);
    const queue = ctx.shards[shardIndex(name)].queues.get(name);
    if (queue) {
      const states = queue.countStatesAt(now);
      counts.waiting += states.waiting;
      counts.prioritized += states.prioritized;
      counts.delayed += states.delayed;
    }
    result.set(name, counts);
  }

  if (ctx.storage) {
    const persistedCompleted = ctx.storage.countCompletedJobsByQueue(result.keys());
    for (const [queue, completed] of persistedCompleted) {
      const counts = result.get(queue);
      if (counts) counts.completed = completed;
    }
  }

  for (const processing of ctx.processingShards) {
    for (const job of processing.values()) {
      const counts = result.get(job.queue);
      if (counts) counts.active++;
    }
  }

  if (!ctx.storage) {
    // Same set as scanning jobIndex for completed entries that are in completedJobs, but
    // walks the bounded completedJobs set instead of every known job.
    for (const jobId of ctx.completedJobs) {
      const location = ctx.jobIndex.get(jobId);
      if (location?.type !== 'completed') continue;
      const counts = result.get(location.queueName);
      if (counts) counts.completed++;
    }
  }

  for (let i = 0; i < SHARD_COUNT; i++) {
    const shard = ctx.shards[i];
    for (const job of shard.waitingChildren.values()) {
      const counts = result.get(job.queue);
      if (counts) counts['waiting-children']++;
    }
    for (const job of shard.waitingDeps.values()) {
      const counts = result.get(job.queue);
      if (counts) counts['waiting-children']++;
    }
  }

  return result;
}

export function getPerQueueStats(
  ctx: StatsContext,
  queueNames: Set<string>
): Map<string, PerQueueStats> {
  const allCounts = getAllQueueJobCounts(queueNames, ctx);
  const result = new Map<string, PerQueueStats>();
  for (const [name, counts] of allCounts) {
    result.set(name, {
      waiting: counts.waiting,
      prioritized: counts.prioritized,
      delayed: counts.delayed,
      active: counts.active,
      dlq: counts.failed,
    });
  }
  return result;
}

export function getQueueJobCounts(queueName: string, ctx: StatsContext): QueueJobCounts {
  return getAllQueueJobCounts([queueName], ctx).get(queueName) ?? createCounts(queueName, ctx);
}
