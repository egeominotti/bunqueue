import { MinHeap } from '../../shared/minHeap';
import type { JobId } from '../types/job';
import type { IndexedJob } from '../types/priorityQueue';

/** Not yet counted as due; counted as due waiting; counted as due prioritized. */
const PENDING = 0;
const DUE_WAITING = 1;
const DUE_PRIORITIZED = 2;

/** Holds the id only, never the job, so a removed job is not kept alive by the heap. */
interface PendingEntry {
  readonly jobId: JobId;
  readonly runAt: number;
}

const byRunAt = (left: PendingEntry, right: PendingEntry): number => left.runAt - right.runAt;

export interface QueueStateCounts {
  waiting: number;
  prioritized: number;
  delayed: number;
}

/**
 * Incremental waiting/prioritized/delayed counts for one indexed queue, with the same
 * classification as a full scan at time `now`: `runAt > now` is delayed, otherwise
 * `priority > 0` is prioritized and anything else is waiting. Jobs that are still in the
 * future wait in a runAt heap and are counted as due once a read reaches their runAt.
 *
 * `clock` is the latest time a job was counted as due against; a read at an earlier
 * time (the clock moved backwards) returns null so the caller rescans.
 */
export class PriorityQueueCounters {
  private clock: number;
  private dueWaiting = 0;
  private duePrioritized = 0;
  private readonly pending = new MinHeap<PendingEntry>(byRunAt);
  /** Most jobs queued since the last compaction; a pull that parks jobs shrinks it briefly. */
  private highWater = 0;
  /** Live jobs per priority value (every state), for per-priority counts. */
  readonly byPriority = new Map<number, number>();

  constructor(
    private readonly index: Map<JobId, IndexedJob>,
    now: number
  ) {
    this.clock = now;
    for (const [jobId, ref] of index) this.add(jobId, ref);
  }

  add(jobId: JobId, ref: IndexedJob): void {
    const job = ref.job;
    this.byPriority.set(job.priority, (this.byPriority.get(job.priority) ?? 0) + 1);
    if (!(job.runAt > this.clock)) {
      this.markDue(ref);
      return;
    }
    // Already due now: any later read (at a time >= now) counts it as due too.
    const now = Date.now();
    if (!(job.runAt > now) && now >= this.clock) {
      this.clock = now;
      this.markDue(ref);
      return;
    }
    ref.due = PENDING;
    this.pending.push({ jobId, runAt: job.runAt });
    if (this.index.size > this.highWater) this.highWater = this.index.size;
    if (this.pending.size > 2 * this.highWater + 1024) this.compact();
  }

  remove(ref: IndexedJob): void {
    const left = (this.byPriority.get(ref.job.priority) ?? 1) - 1;
    if (left > 0) this.byPriority.set(ref.job.priority, left);
    else this.byPriority.delete(ref.job.priority);
    if (ref.due === DUE_WAITING) this.dueWaiting--;
    else if (ref.due === DUE_PRIORITIZED) this.duePrioritized--;
    ref.due = undefined;
  }

  /** Counts at `now`, or null when `now` is before the clock or not a number (rescan). */
  countAt(now: number, size: number): QueueStateCounts | null {
    if (!(now >= this.clock)) return null;
    this.clock = now;
    while (!this.pending.isEmpty) {
      const top = this.pending.peek()!;
      if (top.runAt > now) break;
      this.pending.pop();
      const ref = this.index.get(top.jobId);
      // Stale entries (removed job, or a later runAt) are dropped; duplicates find it due.
      if (ref?.due === PENDING && ref.job.runAt === top.runAt) this.markDue(ref);
    }
    const due = this.dueWaiting + this.duePrioritized;
    return { waiting: this.dueWaiting, prioritized: this.duePrioritized, delayed: size - due };
  }

  /** Drop stale runAt entries left by removed or updated jobs. */
  compact(): void {
    this.highWater = this.index.size;
    const live: PendingEntry[] = [];
    for (const [jobId, ref] of this.index) {
      if (ref.due === PENDING) live.push({ jobId, runAt: ref.job.runAt });
    }
    this.pending.buildFrom(live);
  }

  private markDue(ref: IndexedJob): void {
    if (ref.job.priority > 0) {
      ref.due = DUE_PRIORITIZED;
      this.duePrioritized++;
    } else {
      ref.due = DUE_WAITING;
      this.dueWaiting++;
    }
  }
}

/** Full scan with the same classification, used when the clock moved backwards. */
export function scanQueueStates(jobs: Iterable<IndexedJob>, now: number): QueueStateCounts {
  const counts = { waiting: 0, prioritized: 0, delayed: 0 };
  for (const { job } of jobs) {
    if (job.runAt > now) counts.delayed++;
    else if (job.priority > 0) counts.prioritized++;
    else counts.waiting++;
  }
  return counts;
}
