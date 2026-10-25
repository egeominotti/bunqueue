import type { Job, JobId } from '../../domain/types/job';
import { setBufferedJobState, type PersistedJobState } from './sqliteSerializer';

/** Holes tolerated before a segment compacts, whatever its live size. */
const MIN_HOLES_BEFORE_COMPACTION = 64;

/**
 * One WriteBuffer segment (the active or the flushing buffer): jobs in insertion
 * order plus an id index, so a lookup, a state override or a removal touches only
 * the occurrences of one id instead of scanning the whole buffer.
 *
 * A removal leaves a hole instead of shifting the array. Holes are skipped by every
 * read and compacted once they outnumber the live jobs (amortized O(1) per removal).
 * Each index entry lists the live slots of one id in ascending order; it is either a
 * single slot (the common case) or an array when the same id is buffered twice.
 */
export class PendingSegment {
  private slots: (Job | undefined)[] = [];
  private readonly positions = new Map<JobId, number | number[]>();
  private holes = 0;

  static from(jobs: readonly Job[]): PendingSegment {
    const segment = new PendingSegment();
    for (const job of jobs) segment.push(job);
    return segment;
  }

  /** Number of live jobs. */
  get size(): number {
    return this.slots.length - this.holes;
  }

  push(job: Job): void {
    const slot = this.slots.length;
    this.slots.push(job);
    const entry = this.positions.get(job.id);
    if (entry === undefined) this.positions.set(job.id, slot);
    else if (typeof entry === 'number') this.positions.set(job.id, [entry, slot]);
    else entry.push(slot);
  }

  /** First buffered job with this id, in insertion order. */
  first(jobId: JobId): Job | null {
    const entry = this.positions.get(jobId);
    if (entry === undefined) return null;
    return this.slots[typeof entry === 'number' ? entry : entry[0]] ?? null;
  }

  /** Every buffered job with this id, in insertion order. */
  occurrences(jobId: JobId): Job[] {
    const entry = this.positions.get(jobId);
    if (entry === undefined) return [];
    const slots = typeof entry === 'number' ? [entry] : entry;
    return slots.map((slot) => this.slots[slot] as Job);
  }

  /** Remove every occurrence of this id; the remaining order is unchanged. */
  remove(jobId: JobId): number {
    const entry = this.positions.get(jobId);
    if (entry === undefined) return 0;
    this.positions.delete(jobId);
    const slots = typeof entry === 'number' ? [entry] : entry;
    for (const slot of slots) this.slots[slot] = undefined;
    this.holes += slots.length;
    if (this.holes >= MIN_HOLES_BEFORE_COMPACTION && this.holes > this.size) this.compact();
    return slots.length;
  }

  /** Remove every job matching the predicate (linear), keeping the remaining order. */
  removeWhere(predicate: (job: Job) => boolean, onRemoved: (job: Job) => void): void {
    const kept: Job[] = [];
    let removed = 0;
    for (const job of this.slots) {
      if (job === undefined) continue;
      if (predicate(job)) {
        onRemoved(job);
        removed++;
      } else {
        kept.push(job);
      }
    }
    if (removed > 0) this.reset(kept);
  }

  /** Live jobs in insertion order, as a new array the caller may keep. */
  toArray(): Job[] {
    if (this.holes === 0) return this.slots.slice() as Job[];
    return this.slots.filter((job): job is Job => job !== undefined);
  }

  private compact(): void {
    this.reset(this.toArray());
  }

  private reset(jobs: Job[]): void {
    this.slots = [];
    this.positions.clear();
    this.holes = 0;
    for (const job of jobs) this.push(job);
  }
}

/** The active buffer first, then the buffer being flushed. */
export type PendingBuffers = readonly [active: PendingSegment, flushing: PendingSegment];

export function findPendingJob(buffers: PendingBuffers, jobId: JobId): Job | null {
  return buffers[0].first(jobId) ?? buffers[1].first(jobId);
}

export function setPendingJobState(
  buffers: PendingBuffers,
  jobId: JobId,
  state: PersistedJobState
): boolean {
  let found = false;
  for (const buffer of buffers) {
    for (const job of buffer.occurrences(jobId)) {
      setBufferedJobState(job, state);
      found = true;
    }
  }
  return found;
}

export function listPendingJobs(buffers: PendingBuffers, queue?: string): Job[] {
  const jobs = buffers[0].toArray().concat(buffers[1].toArray());
  return queue === undefined ? jobs : jobs.filter((job) => job.queue === queue);
}

export function removePendingJob(buffers: PendingBuffers, jobId: JobId): void {
  for (const buffer of buffers) buffer.remove(jobId);
}

/** Remove a queue's buffered jobs; returns their distinct ids in buffer order. */
export function removePendingQueue(buffers: PendingBuffers, queue: string): JobId[] {
  const removed = new Set<JobId>();
  for (const buffer of buffers) {
    buffer.removeWhere(
      (job) => job.queue === queue,
      (job) => removed.add(job.id)
    );
  }
  return Array.from(removed);
}
