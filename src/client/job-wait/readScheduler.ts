/**
 * Background state reads of job waits, budgeted per connection.
 *
 * A wait re-reads its job on a schedule (`SAFETY_NET` for event-driven waits,
 * `BROKER_READS` for TCP waits without events), each delay jittered by ±25 % so
 * waits started together do not read in the same tick. All waits on one transport
 * (a connection pool) or one embedded manager share a token bucket: the broker
 * allows each connection 10,000 requests per 60 s (about 167 per second), and the
 * waits' background reads take at most `TCP_READS_PER_SECOND` of that, whatever
 * their number. With more waits than the budget covers, each one is read less
 * often; nothing is dropped.
 */

import { MinHeap } from '../../shared/minHeap';

export interface ReadSchedule {
  firstMs: number;
  maxMs: number;
}

/** Event-driven waits: 5 s after the start, then 10, 20 and every 30 s. */
export const SAFETY_NET: ReadSchedule = { firstMs: 5_000, maxMs: 30_000 };
/** TCP waits without events: 1 s, then 2, 4 ... and every 30 s. */
export const BROKER_READS: ReadSchedule = { firstMs: 1_000, maxMs: 30_000 };

/** About 12 % of one connection's default broker budget (10,000 per 60 s). */
export const TCP_READS_PER_SECOND = 20;
/** In-process reads are cheap; the budget only keeps one tick from blocking. */
export const EMBEDDED_READS_PER_SECOND = 1_000;

type Timer = ReturnType<typeof setTimeout>;

interface Entry {
  read: () => void;
  delay: number;
  readonly maxMs: number;
  version: number;
  live: boolean;
}

interface Node {
  readonly entry: Entry;
  readonly dueAt: number;
  readonly version: number;
}

/** The scheduled reads of one wait. */
export interface ScheduledReads {
  /** Read as soon as the budget allows (events may have been lost). */
  soon(): void;
  stop(): void;
}

function jitter(ms: number): number {
  return ms * (0.75 + Math.random() * 0.5);
}

const noop = () => undefined;

export class ReadScheduler {
  private readonly heap = new MinHeap<Node>((a, b) => a.dueAt - b.dueAt);
  private tokens: number;
  private refilledAt = Date.now();
  private timer: Timer | undefined;
  private timerAt = Number.POSITIVE_INFINITY;
  private live = 0;

  constructor(private readonly perSecond: number) {
    this.tokens = perSecond;
  }

  add(read: () => void, schedule: ReadSchedule): ScheduledReads {
    const entry: Entry = {
      read,
      delay: schedule.firstMs,
      maxMs: schedule.maxMs,
      version: 0,
      live: true,
    };
    this.live++;
    this.push(entry, Date.now() + jitter(entry.delay));
    return {
      soon: () => {
        if (!entry.live) return;
        entry.version++;
        this.push(entry, Date.now());
      },
      stop: () => {
        if (!entry.live) return;
        entry.live = false;
        entry.read = noop;
        this.live--;
        this.compact();
      },
    };
  }

  /** Take one read from the budget now; false when it is spent. */
  tryTake(): boolean {
    this.refill(Date.now());
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  private push(entry: Entry, dueAt: number): void {
    this.heap.push({ entry, dueAt, version: entry.version });
    this.arm(dueAt);
  }

  private refill(now: number): void {
    this.tokens = Math.min(
      this.perSecond,
      this.tokens + ((now - this.refilledAt) * this.perSecond) / 1000
    );
    this.refilledAt = now;
  }

  private arm(at: number): void {
    if (at >= this.timerAt) return;
    clearTimeout(this.timer);
    this.timerAt = at;
    const timer = setTimeout(() => this.run(), Math.max(0, at - Date.now()));
    // Scheduled reads never keep the process alive on their own.
    (timer as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  private run(): void {
    this.timer = undefined;
    this.timerAt = Number.POSITIVE_INFINITY;
    const now = Date.now();
    this.refill(now);
    for (let node = this.heap.peek(); node; node = this.heap.peek()) {
      if (!node.entry.live || node.version !== node.entry.version) {
        this.heap.pop();
        continue;
      }
      if (node.dueAt > now || this.tokens < 1) {
        // Next due read, or the moment the budget has a token again.
        this.arm(Math.max(node.dueAt, now + ((1 - this.tokens) * 1000) / this.perSecond));
        return;
      }
      this.heap.pop();
      this.tokens -= 1;
      const { entry } = node;
      entry.delay = Math.min(entry.delay * 2, entry.maxMs);
      this.push(entry, now + jitter(entry.delay));
      try {
        entry.read();
      } catch {
        // A read reports its own errors to its wait; the others must still run.
      }
    }
  }

  /** Drop the nodes of settled waits once they outnumber the live ones. */
  private compact(): void {
    if (this.live === 0) {
      this.heap.clear();
      clearTimeout(this.timer);
      this.timer = undefined;
      this.timerAt = Number.POSITIVE_INFINITY;
      return;
    }
    if (this.heap.size <= 2 * this.live + 1_024) return;
    this.heap.buildFrom(
      this.heap.toArray().filter((node) => node.entry.live && node.version === node.entry.version)
    );
  }
}

const schedulers = new WeakMap<object, ReadScheduler>();

/** The scheduler shared by every wait on `key` (a transport or a manager). */
export function readSchedulerFor(key: object, perSecond: number): ReadScheduler {
  let scheduler = schedulers.get(key);
  if (!scheduler) {
    scheduler = new ReadScheduler(perSecond);
    schedulers.set(key, scheduler);
  }
  return scheduler;
}
