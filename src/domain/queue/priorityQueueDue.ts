import { MinHeap } from '../../shared/minHeap';
import type { Job, JobId } from '../types/job';
import type { IndexedJob } from '../types/priorityQueue';

/** Holds the id only, never the job, so a removed job is not kept alive by the heaps. */
interface TimedEntry {
  readonly jobId: JobId;
  readonly at: number;
}

const byAt = (left: TimedEntry, right: TimedEntry): number => left.at - right.at;

/**
 * Earliest time at which the job can be ready (`runAt <= now`) or expired
 * (`now > createdAt + ttl`); `createdAt + ttl` is a lower bound, so it is never late.
 * A value that does not compare (NaN) maps to -Infinity: always "may be due".
 */
function dueAt(job: Job): number {
  const at = job.ttl === null ? job.runAt : Math.min(job.runAt, job.createdAt + job.ttl);
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

/**
 * Lower bound of when any job of a queue can be ready or expired, plus the earliest runAt.
 * When nothing can be due yet, a pull scan would only park every job and report the
 * earliest runAt; this answers that outcome without visiting the jobs.
 *
 * An entry is live while its job is queued with the same time; anything else is stale
 * and dropped when it reaches the top or at the next rebuild.
 */
export class DueTracker {
  private readonly due = new MinHeap<TimedEntry>(byAt);
  private readonly runAt = new MinHeap<TimedEntry>(byAt);
  /** Most jobs queued since the last rebuild. */
  private highWater = 0;

  add(job: Job, index: Map<JobId, IndexedJob>): void {
    this.due.push({ jobId: job.id, at: dueAt(job) });
    // A NaN runAt is always due (see dueAt), so it never decides an idle answer
    if (!Number.isNaN(job.runAt)) this.runAt.push({ jobId: job.id, at: job.runAt });
    if (index.size > this.highWater) this.highWater = index.size;
    if (this.due.size + this.runAt.size > 4 * this.highWater + 2048) this.rebuild(index);
  }

  /**
   * `undefined` when some live job may be ready or expired at `now`. Otherwise the
   * earliest runAt of the live jobs, or null when there are none.
   */
  idleRunAt(now: number, index: Map<JobId, IndexedJob>): number | null | undefined {
    const due = this.liveTop(this.due, index, dueAt);
    if (due !== null && !(due.at > now)) return undefined;
    return this.liveTop(this.runAt, index, (job) => job.runAt)?.at ?? null;
  }

  /** Rebuild from the live jobs, dropping stale entries. */
  rebuild(index: Map<JobId, IndexedJob>): void {
    this.highWater = index.size;
    const due: TimedEntry[] = [];
    const runAt: TimedEntry[] = [];
    for (const [jobId, { job }] of index) {
      due.push({ jobId, at: dueAt(job) });
      if (!Number.isNaN(job.runAt)) runAt.push({ jobId, at: job.runAt });
    }
    this.due.buildFrom(due);
    this.runAt.buildFrom(runAt);
  }

  private liveTop(
    heap: MinHeap<TimedEntry>,
    index: Map<JobId, IndexedJob>,
    timeOf: (job: Job) => number
  ): TimedEntry | null {
    while (!heap.isEmpty) {
      const top = heap.peek()!;
      const queued = index.get(top.jobId)?.job;
      if (queued && timeOf(queued) === top.at) return top;
      heap.pop();
    }
    return null;
  }
}
