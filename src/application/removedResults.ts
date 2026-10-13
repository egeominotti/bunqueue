/**
 * Removed-result retention: a short-lived, bounded, memory-only record of the result of
 * each job removed on completion (`removeOnComplete`), for the memory and SQLite engines.
 *
 * Such a job leaves nothing a later read can find, so a wait that reached the broker
 * after the completion (`waitUntilFinished` without QueueEvents in a request/reply loop,
 * or with QueueEvents once the event has gone by) used to settle with `Job <id> not
 * found`. The completion lookup (`QueueManager.getCompletionAsync`: WaitJob, the
 * embedded wait reader) answers from this record instead, while it lives.
 *
 * - Presence means "completed": a record is kept even when the result is `undefined`.
 * - A record lives `ttlMs` (default 60 s) and at most `maxEntries` (default 1,000)
 *   records exist; `ttlMs` or `maxEntries` of 0 disables the record entirely.
 * - Records sit in a ring of at most `maxEntries` slots in insertion order, which is
 *   expiry order (one TTL, a monotonic clock), so expired and over-cap records are
 *   evicted from the head: O(1) amortized, no per-entry timers. Over the cap, 10% of the
 *   slots are freed at once. A completion only writes its slot: the `jobId` index is
 *   built lazily by the first read after it (lookup, forget, size, purge). A dropped
 *   record (forgotten, expired on read, superseded by a later record of the same ID)
 *   releases its result at once and its slot when the head passes it.
 * - The ring's capacity follows the occupied slots, not the cap: it doubles when full
 *   (up to `maxEntries`) and halves, down to `MIN_CAPACITY`, when an eviction leaves it at
 *   most a quarter full. A resize re-lays the occupied slots from 0 and moves the indexed
 *   ones (amortized O(1) per record), so a large cap with few live records holds few
 *   slots instead of growing its four slot arrays to the cap until restart.
 * - The batch ACK path stamps all of its records with one clock reading (`now()`), taken
 *   right before them, so a record expires at most that batch's duration early, never late.
 * - Nothing is persisted: a restart, `shutdown()` or `obliterate` drops the records, a
 *   remove (`Cancel`) of the ID drops its record, and so does a Cancel outcome that
 *   reports the ID missing (`forgetRemovedResult`, after its state read); a new
 *   generation under the same ID drops it when it is admitted. The periodic cleanup
 *   purges expired records even when no new completion arrives, so the TTL also bounds
 *   how long a result is held.
 *
 * See docs/features/core-queue-engine.md ("Removed-result retention").
 */

import type { JobId } from '../domain/types/job';

/** Defaults: one minute, and a small cap (only results not yet read are worth keeping). */
export const REMOVED_RESULT_DEFAULTS = { ttlMs: 60_000, maxEntries: 1_000 } as const;

/** One retained completion. */
export interface RemovedResultRecord {
  readonly queue: string;
  readonly result: unknown;
  /** Clock reading (ms) at which the record stops answering. */
  readonly expiresAt: number;
}

export interface RemovedResultsOptions {
  /** How long a record answers, in ms; 0 disables the retention. */
  readonly ttlMs: number;
  /** Maximum number of records; 0 disables the retention. */
  readonly maxEntries: number;
  /** Monotonic millisecond clock (default `performance.now`); tests inject one. */
  readonly clock?: () => number;
}

const defaultClock = (): number => performance.now();

/** Smallest ring capacity a shrink keeps (the cap still applies below it). */
const MIN_CAPACITY = 16;

export class RemovedResults {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly evictBatch: number;
  private readonly clock: () => number;
  /** The ring, one slot per record; a dropped slot holds `undefined` until evicted. */
  private jobIds: Array<JobId | undefined> = [];
  private queues: Array<string | undefined> = [];
  private results: unknown[] = [];
  private expiries: number[] = [];
  /** Slots in the ring now (at most `maxEntries`); the arrays never exceed it. */
  private slots = 0;
  /** Slot of the oldest record, and the number of occupied slots from it. */
  private head = 0;
  private count = 0;
  /** The newest `pending` occupied slots are not in `index` yet. */
  private pending = 0;
  /** Occupied slots whose record was dropped. */
  private dropped = 0;
  /** `jobId` -> slot of its live record, for the occupied slots older than `pending`. */
  private readonly index = new Map<JobId, number>();

  constructor(options: RemovedResultsOptions) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
    this.evictBatch = Math.max(1, Math.ceil(options.maxEntries * 0.1));
    this.clock = options.clock ?? defaultClock;
  }

  /** False when the TTL or the cap is 0: nothing is recorded, nothing answers. */
  get enabled(): boolean {
    return this.ttlMs > 0 && this.maxEntries > 0;
  }

  get size(): number {
    if (this.pending > 0) this.sync();
    return this.count - this.dropped;
  }

  /** Slots the ring holds now, live or not (diagnostics): never more than the cap. */
  get capacity(): number {
    return this.slots;
  }

  /** One clock reading to stamp a batch of records with (see `record`). */
  now(): number {
    return this.clock();
  }

  /**
   * Record the completion of `jobId`, removed on completion with `result`. `now` is a
   * reading of this store's clock (`now()`), taken once for a batch; default: read now.
   */
  record(jobId: JobId, queue: string, result: unknown, now = this.clock()): void {
    if (!(this.ttlMs > 0 && this.maxEntries > 0)) return;
    if (this.count >= this.maxEntries) this.evict(now, this.evictBatch);
    else if (this.count > 0 && now >= this.expiries[this.head]) this.evict(now, 0);
    // Below the cap after the eviction above, so a full ring can still grow.
    if (this.count === this.slots) {
      this.resize(Math.min(this.maxEntries, Math.max(MIN_CAPACITY, this.slots * 2)));
    }
    let slot = this.head + this.count;
    if (slot >= this.slots) slot -= this.slots;
    this.jobIds[slot] = jobId;
    this.queues[slot] = queue;
    this.results[slot] = result;
    this.expiries[slot] = now + this.ttlMs;
    this.count++;
    this.pending++;
  }

  /** The unexpired record of `jobId`, if any; an expired one is dropped. */
  lookup(jobId: JobId): RemovedResultRecord | undefined {
    if (this.pending > 0) this.sync();
    const slot = this.index.get(jobId);
    if (slot === undefined) return undefined;
    const expiresAt = this.expiries[slot];
    if (expiresAt > this.clock()) {
      return { queue: this.queues[slot] as string, result: this.results[slot], expiresAt };
    }
    this.index.delete(jobId);
    this.drop(slot);
    return undefined;
  }

  /** Drop the record of `jobId` (remove, new generation); true when one existed. */
  forget(jobId: JobId): boolean {
    if (this.pending > 0) this.sync();
    const slot = this.index.get(jobId);
    if (slot === undefined) return false;
    this.index.delete(jobId);
    this.drop(slot);
    return true;
  }

  /** Drop every record of `queue` (obliterate); returns how many were dropped. */
  forgetQueue(queue: string): number {
    if (this.pending > 0) this.sync();
    let forgotten = 0;
    for (let n = 0, slot = this.head; n < this.count; n++, slot = this.next(slot)) {
      const jobId = this.jobIds[slot];
      if (jobId === undefined || this.queues[slot] !== queue) continue;
      this.index.delete(jobId);
      this.drop(slot);
      forgotten++;
    }
    return forgotten;
  }

  /** Drop every expired record (the periodic cleanup); returns how many were dropped. */
  purgeExpired(): number {
    if (this.count === 0) return 0;
    const now = this.clock();
    if (now < this.expiries[this.head]) return 0;
    // Index first, so a superseded record is not counted as a purged one.
    if (this.pending > 0) this.sync();
    return this.evict(now, 0);
  }

  clear(): void {
    this.jobIds.length = 0;
    this.queues.length = 0;
    this.results.length = 0;
    this.expiries.length = 0;
    this.index.clear();
    this.slots = 0;
    this.head = 0;
    this.count = 0;
    this.pending = 0;
    this.dropped = 0;
  }

  private next(slot: number): number {
    return slot + 1 === this.slots ? 0 : slot + 1;
  }

  /**
   * Re-lay the occupied slots from slot 0 in a ring of `slots` (at least `count`), with
   * fresh arrays so a shrink releases the old ones, and move every indexed slot along.
   */
  private resize(slots: number): void {
    const jobIds: Array<JobId | undefined> = [];
    const queues: Array<string | undefined> = [];
    const results: unknown[] = [];
    const expiries: number[] = [];
    for (let n = 0, slot = this.head; n < this.count; n++, slot = this.next(slot)) {
      jobIds.push(this.jobIds[slot]);
      queues.push(this.queues[slot]);
      results.push(this.results[slot]);
      expiries.push(this.expiries[slot]);
    }
    // Every indexed slot is occupied, so it moves by its distance from the head.
    const head = this.head;
    const wrap = this.slots - head;
    for (const [jobId, slot] of this.index) {
      this.index.set(jobId, slot >= head ? slot - head : slot + wrap);
    }
    this.jobIds = jobIds;
    this.queues = queues;
    this.results = results;
    this.expiries = expiries;
    this.slots = slots;
    this.head = 0;
  }

  /** After an eviction: halve the ring while it is at most a quarter full. */
  private shrinkIfSparse(): void {
    let slots = this.slots;
    while (slots > MIN_CAPACITY && this.count * 4 <= slots) {
      slots = Math.max(MIN_CAPACITY, Math.floor(slots / 2));
    }
    if (slots < this.slots) this.resize(slots);
  }

  /**
   * Index the pending records, oldest first. A record of an ID that already has one
   * supersedes it, as a re-record always did: the older one is dropped.
   */
  private sync(): void {
    let slot = this.head + this.count - this.pending;
    if (slot >= this.slots) slot -= this.slots;
    for (let n = 0; n < this.pending; n++, slot = this.next(slot)) {
      // A pending slot is never dropped: every drop indexes first.
      const jobId = this.jobIds[slot] as JobId;
      const superseded = this.index.get(jobId);
      if (superseded !== undefined) this.drop(superseded);
      this.index.set(jobId, slot);
    }
    this.pending = 0;
  }

  /** Release the record in `slot`; its slot stays occupied until the head passes it. */
  private drop(slot: number): void {
    this.jobIds[slot] = undefined;
    this.queues[slot] = undefined;
    this.results[slot] = undefined;
    this.dropped++;
  }

  /**
   * Free slots from the head: at least `minimum`, then every one whose record is expired
   * or dropped. Returns how many live records were evicted.
   */
  private evict(now: number, minimum: number): number {
    let freed = 0;
    let evicted = 0;
    while (this.count > 0) {
      const slot = this.head;
      const jobId = this.jobIds[slot];
      if (jobId === undefined) {
        this.dropped--;
      } else {
        if (freed >= minimum && this.expiries[slot] > now) break;
        // The head is indexed unless every occupied slot is pending.
        if (this.count > this.pending) this.index.delete(jobId);
        this.jobIds[slot] = undefined;
        this.queues[slot] = undefined;
        this.results[slot] = undefined;
        evicted++;
      }
      this.head = this.next(slot);
      this.count--;
      if (this.pending > this.count) this.pending = this.count;
      freed++;
    }
    if (freed > 0) this.shrinkIfSparse();
    return evicted;
  }
}
