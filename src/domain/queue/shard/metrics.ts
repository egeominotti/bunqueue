import type { JobId } from '../../types/job';
import type { ShardStats } from '../shardCounters';
import { ShardDlq } from './dlq';

/** A number that becomes an array-index property key (ordered numerically by objects). */
const isArrayIndexKey = (key: number): boolean =>
  Number.isInteger(key) && key >= 0 && key <= 4_294_967_294;

/** Queue counts, running counters, and temporal-index operations. */
export class ShardMetrics extends ShardDlq {
  getWaitingCount(queue: string): number {
    return this.queues.get(queue)?.size ?? 0;
  }
  getDlqCount(queue: string): number {
    return this.dlqManager.getCount(queue);
  }
  getCountsPerPriority(queue: string): Map<number, number> {
    const priorityQueue = this.queues.get(queue);
    const counts = new Map<number, number>();
    if (!priorityQueue) return counts;
    // Callers expose these as object keys: array-index keys are ordered numerically
    // whatever the insertion order, so the tracked counts are the same object. Any other
    // key keeps its first-seen scan order, so it takes the scan below.
    const tracked = priorityQueue.countsPerPriority();
    if ([...tracked.keys()].every(isArrayIndexKey)) return new Map(tracked);
    for (const job of priorityQueue.values()) {
      const count = counts.get(job.priority) ?? 0;
      counts.set(job.priority, count + 1);
    }
    return counts;
  }
  getStats(): ShardStats {
    return this.counters.getStats();
  }
  getInternalSizes(): {
    delayedJobIds: number;
    delayedHeap: number;
    delayedRunAt: number;
    temporalIndex: number;
    waiters: number;
  } {
    const sizes = this.temporalManager.getSizes();
    return { ...sizes, waiters: this.waiterManager.length };
  }
  incrementQueued(
    jobId: JobId,
    isDelayed: boolean,
    createdAt?: number,
    queue?: string,
    runAt?: number
  ): void {
    this.counters.incrementQueued(jobId, isDelayed, createdAt, queue, runAt);
  }
  decrementQueued(jobId: JobId): void {
    this.counters.decrementQueued(jobId);
  }
  promoteDelayed(jobId: JobId): void {
    this.temporalManager.removeDelayed(jobId);
    this.counters.syncDelayedCount();
  }
  incrementDlq(): void {
    this.counters.incrementDlq();
  }
  decrementDlq(count: number = 1): void {
    this.counters.decrementDlq(count);
  }
  refreshDelayedCount(now: number): void {
    this.counters.refreshDelayedCount(now);
  }
  resetQueuedCounters(): void {
    this.counters.resetQueuedCounters();
  }
  resetDlqCounter(): void {
    this.counters.resetDlqCounter();
  }
  getOldJobs(
    queue: string,
    thresholdMs: number,
    limit: number
  ): Array<{ jobId: JobId; createdAt: number }> {
    return this.temporalManager.getOldJobs(queue, thresholdMs, limit);
  }
  removeFromTemporalIndex(jobId: JobId): void {
    this.temporalManager.removeFromIndex(jobId);
  }
  clearTemporalIndexForQueue(queue: string): void {
    this.temporalManager.clearIndexForQueue(queue);
  }
  cleanOrphanedTemporalEntries(): number {
    if (this.temporalManager.indexSize === 0) return 0;
    // "Is the job in any queue of this shard": asked of the queues directly when they are
    // few, instead of copying every queued id into a Set first.
    if (this.queues.size <= 8) {
      const queues = Array.from(this.queues.values());
      return this.temporalManager.cleanOrphaned({
        has: (jobId) => queues.some((queue) => queue.has(jobId)),
      });
    }
    const validJobIds = new Set<JobId>();
    for (const priorityQueue of this.queues.values()) {
      for (const job of priorityQueue.values()) validJobIds.add(job.id);
    }
    return this.temporalManager.cleanOrphaned(validJobIds);
  }
}
