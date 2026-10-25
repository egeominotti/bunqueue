import { copyGroupFifoOrder } from '../job/groupFifoOrder';
import { type Job, type JobId, isExpired, isReady } from '../types/job';
import type { HeapEntry, IndexedJob } from '../types/priorityQueue';
import {
  PriorityQueueCounters,
  scanQueueStates,
  type QueueStateCounts,
} from './priorityQueueCounters';
import { DueTracker } from './priorityQueueDue';
import { comparePriorityEntries } from './priorityQueueOrder';

export interface PriorityQueueHooks {
  onInsert(job: Job): boolean;
  onRemove(job: Job): boolean;
}

export type PriorityQueueComparator = (left: HeapEntry, right: HeapEntry) => number;
export type PriorityQueueOrder = (job: Job) => bigint | null;

/** Indexed map-backed 4-ary heap with O(log4 n) mutations and O(1) lookup. */
export class IndexedPriorityQueue {
  private static readonly D = 4;
  private heap: HeapEntry[] = [];
  private readonly index: Map<JobId, IndexedJob> = new Map();
  private counters: PriorityQueueCounters | null = null;
  /** Built after a pull scan found nothing due, dropped once a scan dequeues again. */
  private due: DueTracker | null = null;
  private idleHint = false;
  private generation = 0n;
  private hooksActive = false;

  constructor(
    private readonly hooks?: PriorityQueueHooks,
    private readonly compare: PriorityQueueComparator = comparePriorityEntries,
    private readonly order?: PriorityQueueOrder,
    private readonly trackDue = false
  ) {}

  get size(): number {
    return this.index.size;
  }

  get isEmpty(): boolean {
    return this.index.size === 0;
  }

  push(job: Job): void {
    this.insert(job);
  }

  /** Index the job under a new generation and add its heap entry. */
  private insert(job: Job): void {
    const gen = this.generation++;
    const previous = this.counters ? this.index.get(job.id) : undefined;
    if (previous) this.counters?.remove(previous);
    const indexed: IndexedJob = { job, generation: gen };
    this.index.set(job.id, indexed);
    this.counters?.add(job.id, indexed);
    this.due?.add(job, this.index);
    const entry: HeapEntry = {
      jobId: job.id,
      priority: job.priority,
      runAt: job.runAt,
      lifo: job.lifo,
      generation: gen,
    };
    if (this.order) {
      const groupFifoOrder = this.order(job);
      if (groupFifoOrder !== null) entry.groupFifoOrder = groupFifoOrder;
    }
    this.heap.push(entry);
    this.bubbleUp(this.heap.length - 1);
    if (this.hooks && (this.hooksActive || job.groupId)) {
      this.hooksActive = this.hooks.onInsert(job);
    }
  }

  pop(): Job | null {
    while (this.heap.length > 0) {
      const entry = this.heap[0];
      const indexed = this.index.get(entry.jobId);
      if (indexed?.generation !== entry.generation) {
        this.removeTop();
        continue;
      }
      this.removeTop();
      this.index.delete(entry.jobId);
      this.counters?.remove(indexed);
      this.due = null;
      this.idleHint = false;
      if (this.hooks && this.hooksActive) {
        this.hooksActive = this.hooks.onRemove(indexed.job);
      }
      return indexed.job;
    }
    return null;
  }

  peek(): Job | null {
    while (this.heap.length > 0) {
      const entry = this.heap[0];
      const indexed = this.index.get(entry.jobId);
      if (indexed?.generation !== entry.generation) {
        this.removeTop();
        continue;
      }
      return indexed.job;
    }
    return null;
  }

  find(jobId: JobId): Job | null {
    return this.index.get(jobId)?.job ?? null;
  }

  has(jobId: JobId): boolean {
    return this.index.has(jobId);
  }

  remove(jobId: JobId): Job | null {
    const indexed = this.index.get(jobId);
    if (!indexed) return null;

    this.index.delete(jobId);
    this.counters?.remove(indexed);
    if (this.hooks && this.hooksActive) {
      this.hooksActive = this.hooks.onRemove(indexed.job);
    }
    return indexed.job;
  }

  /** Update job priority - O(log n). Optionally update the LIFO tie-break flag. */
  updatePriority(jobId: JobId, newPriority: number, newLifo?: boolean): boolean {
    const indexed = this.index.get(jobId);
    if (!indexed) return false;

    const lifo = newLifo ?? indexed.job.lifo;
    return this.reinsert(indexed, { ...indexed.job, priority: newPriority, lifo });
  }

  /** Update job runAt (for delay changes) - O(log n) */
  updateRunAt(jobId: JobId, newRunAt: number): boolean {
    const indexed = this.index.get(jobId);
    if (!indexed) return false;
    return this.reinsert(indexed, { ...indexed.job, runAt: newRunAt });
  }

  /** Live jobs per priority (insertion order of the priorities is not the scan's order). */
  countsPerPriority(): ReadonlyMap<number, number> {
    this.counters ??= new PriorityQueueCounters(this.index, Date.now());
    return this.counters.byPriority;
  }

  /** Waiting/prioritized/delayed counts at `now`, kept incrementally after the first read. */
  countStatesAt(now: number): QueueStateCounts {
    this.counters ??= new PriorityQueueCounters(this.index, now);
    return this.counters.countAt(now, this.index.size) ?? scanQueueStates(this.index.values(), now);
  }

  /**
   * See `DueTracker.idleRunAt`. `undefined` (scan normally) unless the last pull scan of a
   * due-tracking queue found nothing due; the tracker is built then and kept up to date.
   */
  idleRunAt(now: number): number | null | undefined {
    if (!this.due) {
      if (!this.idleHint) return undefined;
      const top = this.peek();
      if (top && (isReady(top, now) || isExpired(top, now))) return undefined;
      this.due = new DueTracker();
      this.due.rebuild(this.index);
    }
    return this.due.idleRunAt(now, this.index);
  }

  /** A pull scan visited every job and found none due. */
  markExhausted(): void {
    this.idleHint = this.trackDue;
  }

  values(): Job[] {
    return Array.from(this.index.values()).map((v) => v.job);
  }

  /** Visit every queued job in `values()` order, without copying them into arrays. */
  forEachJob(visit: (job: Job) => void): void {
    for (const indexed of this.index.values()) visit(indexed.job);
  }

  clear(): void {
    if (this.hooks) {
      for (const { job } of this.index.values()) {
        if (!this.hooksActive) break;
        this.hooksActive = this.hooks.onRemove(job);
      }
    }
    this.heap = [];
    this.index.clear();
    this.counters = null;
    this.due = null;
    this.idleHint = false;
    this.generation = 0n;
    this.hooksActive = false;
  }

  /** Ratio of stale entries in the heap, used to decide when to compact. */
  getStaleRatio(): number {
    if (this.heap.length === 0) return 0;
    return 1 - this.index.size / this.heap.length;
  }

  /** Compact the heap by removing stale entries - O(n); called above a stale-ratio threshold. */
  compact(): void {
    if (this.heap.length === 0) return;

    const validEntries: HeapEntry[] = [];
    for (const entry of this.heap) {
      const indexed = this.index.get(entry.jobId);
      if (indexed?.generation === entry.generation) {
        validEntries.push(entry);
      }
    }

    this.heap = validEntries;
    this.heapify();
    this.counters?.compact();
    this.due?.rebuild(this.index);
  }

  /** Replace a job with its updated copy: new generation, new heap entry, same hooks. */
  private reinsert(indexed: IndexedJob, updatedJob: Job): boolean {
    copyGroupFifoOrder(indexed.job, updatedJob);
    this.insert(updatedJob);
    return true;
  }

  private heapify(): void {
    const D = IndexedPriorityQueue.D;
    for (let i = Math.floor((this.heap.length - 2) / D); i >= 0; i--) {
      this.bubbleDown(i);
    }
  }

  /** Check if compaction is needed (stale ratio > threshold) */
  needsCompaction(threshold: number = 0.2): boolean {
    return this.getStaleRatio() > threshold;
  }

  private removeTop(): void {
    if (this.heap.length <= 1) {
      this.heap.pop();
      return;
    }
    this.heap[0] = this.heap.pop()!;
    this.bubbleDown(0);
  }

  /** 4-ary bubbleUp: parent at floor((idx-1)/D) */
  private bubbleUp(idx: number): void {
    const D = IndexedPriorityQueue.D;
    while (idx > 0) {
      const parentIdx = Math.floor((idx - 1) / D);
      if (this.compare(this.heap[idx], this.heap[parentIdx]) >= 0) {
        break;
      }
      this.swap(idx, parentIdx);
      idx = parentIdx;
    }
  }

  /** 4-ary bubbleDown: children at D*idx+1 through D*idx+D */
  private bubbleDown(idx: number): void {
    const D = IndexedPriorityQueue.D;
    const length = this.heap.length;
    const heap = this.heap;

    while (true) {
      const firstChild = D * idx + 1;
      if (firstChild >= length) break;

      let smallest = idx;
      const lastChild = Math.min(firstChild + D, length);

      for (let c = firstChild; c < lastChild; c++) {
        if (this.compare(heap[c], heap[smallest]) < 0) {
          smallest = c;
        }
      }

      if (smallest === idx) break;
      this.swap(idx, smallest);
      idx = smallest;
    }
  }

  private swap(i: number, j: number): void {
    const temp = this.heap[i];
    this.heap[i] = this.heap[j];
    this.heap[j] = temp;
  }
}
