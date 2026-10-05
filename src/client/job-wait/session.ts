/** The state of one job wait: settles once, owns its timers, coalesces state reads. */

import { safeDeadline, safeTimeout, type SafeTimer } from '../../shared/timers';
import type { ReadSchedule, ReadScheduler, ScheduledReads } from './readScheduler';
import { isTransientError, type Outcome, type OutcomeReader, type WaitLimit } from './types';

/** How long the read made when the TTL elapses may delay the timeout. */
const FINAL_READ_MS = 1_000;

export interface SessionOptions {
  reader: OutcomeReader;
  finish: (outcome: Outcome) => void;
  /** The budget shared with the other waits on the same transport or manager. */
  scheduler: ReadScheduler;
  /**
   * Runs before the wait settles on a missing job, so that an event still in
   * flight (the completion of a job removed on completion) wins.
   */
  confirmMissing?: () => Promise<unknown>;
}

export class JobWaitSession {
  private done = false;
  private readonly cleanups: Array<() => void> = [];
  private readonly sleeps = new Map<SafeTimer, () => void>();
  private deadlineTimer: SafeTimer | undefined;
  private reads: ScheduledReads | undefined;
  private firstRead: Promise<void> | undefined;
  private reading = false;
  private readAgain = false;

  constructor(private readonly options: SessionOptions) {}

  get settled(): boolean {
    return this.done;
  }

  settle(outcome: Outcome): void {
    if (this.done) return;
    this.done = true;
    this.deadlineTimer?.clear();
    this.reads?.stop();
    for (const [timer, wake] of this.sleeps) {
      timer.clear();
      wake();
    }
    this.sleeps.clear();
    for (const cleanup of this.cleanups.splice(0)) runQuietly(cleanup);
    this.options.finish(outcome);
  }

  fail(error: unknown): void {
    this.settle({ error: error instanceof Error ? error : new Error(String(error)) });
  }

  /** Run `cleanup` when the wait settles, or at once when it already has. */
  onSettle(cleanup: () => void): void {
    if (this.done) runQuietly(cleanup);
    else this.cleanups.push(cleanup);
  }

  /** The first state read; later calls return the same read. */
  readFirst(): Promise<void> {
    this.firstRead ??= this.read();
    return this.firstRead;
  }

  /**
   * Read again now (a hint for this job). Requests during a read add one more
   * read, not one each.
   */
  recheck(): void {
    if (this.done) return;
    if (this.reading) {
      this.readAgain = true;
      return;
    }
    void this.read();
  }

  /** Read again as soon as the shared budget allows (events may have been lost). */
  recheckSoon(): void {
    if (this.reads) this.reads.soon();
    else this.recheck();
  }

  /** Read on `schedule` within the shared budget until the wait settles. */
  scheduleReads(schedule: ReadSchedule): void {
    if (this.done) return;
    this.reads?.stop();
    this.reads = this.options.scheduler.add(() => this.recheck(), schedule);
  }

  /**
   * Reject with the limit's message at its deadline, after one more read when the
   * budget allows (at most 1 s), so a job that finished unseen settles on its outcome.
   * A deadline beyond the runtime's timer limit is armed in chunks (`safeDeadline` in
   * `shared/timers.ts`); its timers keep the process alive, so a script awaiting the
   * wait does not exit.
   */
  armDeadline(limit: WaitLimit): void {
    if (this.done || !Number.isFinite(limit.deadline)) return;
    const timedOut = { error: new Error(limit.message) };
    this.deadlineTimer = safeDeadline(() => {
      if (!this.options.scheduler.tryTake()) {
        this.settle(timedOut);
        return;
      }
      // Kept alive like the TTL itself: a script waiting on this wait must not exit
      // while the last read is pending.
      this.deadlineTimer = safeDeadline(() => this.settle(timedOut), Date.now() + FINAL_READ_MS);
      void this.outcome().then(
        (outcome) => this.settle(outcome ?? timedOut),
        () => this.settle(timedOut)
      );
    }, limit.deadline);
  }

  /** Resolve after `ms`, or at once when the wait settles; never keeps the process alive. */
  sleep(ms: number): Promise<null> {
    // `!(ms > 0)` also catches NaN, which `ms <= 0` let through to a native timer.
    if (this.done || !(ms > 0)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = safeTimeout(() => {
        this.sleeps.delete(timer);
        resolve(null);
      }, ms).unref();
      this.sleeps.set(timer, () => resolve(null));
    });
  }

  /** One read, with a missing job confirmed first; null while the job can still change. */
  async outcome(): Promise<Outcome | null> {
    const outcome = await this.options.reader.read();
    if (outcome && 'missing' in outcome && this.options.confirmMissing && !this.done) {
      await this.options.confirmMissing().catch(() => undefined);
    }
    return outcome;
  }

  /**
   * A read that fails for a transient reason (rate limit, command timeout, lost
   * connection) is retried by the next scheduled read, the first one included: it says
   * nothing about the job. Any other failure (a refused token, a closed pool) is final.
   */
  private async read(): Promise<void> {
    if (this.done) return;
    this.reading = true;
    try {
      const outcome = await this.outcome();
      if (outcome) this.settle(outcome);
    } catch (error) {
      if (!isTransientError(error)) this.fail(error);
    } finally {
      this.reading = false;
    }
    if (this.readAgain && !this.done) {
      this.readAgain = false;
      void this.read();
    }
  }
}

function runQuietly(cleanup: () => void): void {
  try {
    cleanup();
  } catch {
    // Removing a listener is best effort: the outcome must still reach the caller.
  }
}
