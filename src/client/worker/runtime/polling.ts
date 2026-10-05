import { safeTimeout } from '../../../shared/timers';
import { WORKER_CONSTANTS } from '../constants';
import { isQuietPullFailure } from '../pullFailureLog';
import { pullEmbedded, pullTcp, type PullConfig } from '../workerPull';
import { WorkerBuffer } from './buffer';
import type { PulledJob, WorkerDelivery } from './state';

/**
 * What `doPullBatch` returns for a transient refusal (`isQuietPullFailure`: the broker's
 * rate limit, a lock timeout, a redacted internal error): no job, as 2.9.10 read it. The
 * pull loop then re-polls on its empty-pull cadence (`pollTimeout > 0 ? 10 :
 * drainDelay`) and a native-batch refill on its 10 ms refill timer, with no failure
 * streak, instead of the 100 ms..30 s backoff of a permanent refusal; only `drained` is
 * not emitted, since the queue was not seen empty.
 */
const QUIET_REFUSAL = Object.freeze([]) as unknown as PulledJob[];

export abstract class WorkerPolling<T = unknown, R = unknown> extends WorkerBuffer<T, R> {
  protected poll(): void {
    this.clearPollTimer();
    if (!this.running || this._closing) return;

    if (this.activeJobs >= this.opts.concurrency) {
      this.schedulePoll(10);
      return;
    }

    if (!this.rateLimiter.canProcessWithinLimit()) {
      this.scheduleRateLimitPoll();
      return;
    }

    void this.tryProcess();
  }

  protected scheduleProcessing(): void {
    if (!this.running || this._closing || this.processingScheduled) return;
    this.processingScheduled = true;
    setImmediate(() => {
      this.processingScheduled = false;
      void this.tryProcess();
    });
  }

  protected async tryProcess(): Promise<void> {
    if (!this.running || this._closing) return;

    let refused = false;
    try {
      let item = this.getNextEligibleJob();
      if (!item) {
        if (!this.rateLimiter.canProcessWithinLimit()) {
          this.scheduleRateLimitPoll();
          return;
        }
        const pulledItems = await this.doPullBatch();
        if (!this.running || this._closing) return;
        refused = pulledItems === QUIET_REFUSAL;
        // A pull the broker answered, even with no job, ends a failure streak; otherwise
        // occasional refusals between empty polls would escalate the backoff to 30 s.
        this.consecutiveErrors = 0;
        if (pulledItems.length > 0) {
          const items = this.registerPulledJobs(pulledItems);
          if (this.pendingJobsHead >= this.pendingJobs.length) {
            this.pendingJobs = items;
            this.pendingJobsHead = 0;
          } else {
            this.pendingJobs = this.pendingJobs.slice(this.pendingJobsHead).concat(items);
            this.pendingJobsHead = 0;
          }
          item = this.getNextEligibleJob();
        }
      }

      if (item) {
        if (this.activeJobs >= this.opts.concurrency) {
          this.requeueItem(item);
          this.schedulePoll(10);
          return;
        }
        if (!this.startJob(item)) {
          this.requeueItem(item);
          this.scheduleRateLimitPoll();
        }
      } else {
        const hasBuffered = this.pendingJobsHead < this.pendingJobs.length;
        if (hasBuffered && this.groupLimiter) {
          this.schedulePoll(10);
          return;
        }
        const now = Date.now();
        if (!refused && now - this.lastDrainedEmit > 1000) {
          this.lastDrainedEmit = now;
          this.emit('drained');
        }
        const waitTime = this.opts.pollTimeout > 0 ? 10 : this.opts.drainDelay;
        this.schedulePoll(waitTime);
      }
    } catch (error) {
      if (!this.running) return;
      this.handlePullError(error);
    }
  }

  protected async doPullBatch(): Promise<PulledJob[]> {
    const groupBlockedBuffer =
      this.groupLimiter !== null && this.pendingJobsHead < this.pendingJobs.length;
    const leased = groupBlockedBuffer ? this.activeJobs : this.pulledJobIds.size;
    const capacity = this.opts.batch
      ? this.opts.concurrency * this.opts.batch.size
      : this.opts.concurrency;
    const slots = capacity - leased - this.pendingPull;
    const rateSlots = this.rateLimiter.getAvailableSlots() - this.pendingPull;
    const configuredBatchSize =
      this.opts.batch?.groupAffinity && this.batchAffinity === undefined ? 1 : this.opts.batchSize;
    const batchSize = Math.min(configuredBatchSize, slots, rateSlots, 1000);
    if (batchSize <= 0) return [];

    const config = this.getPullConfig();
    this.pendingPull += batchSize;
    try {
      return this.embedded
        ? await pullEmbedded(config, batchSize)
        : await pullTcp(config, this.tcp as NonNullable<typeof this.tcp>, batchSize, this._closing);
    } catch (error) {
      if (isQuietPullFailure(error)) return QUIET_REFUSAL;
      throw error;
    } finally {
      this.pendingPull -= batchSize;
    }
  }

  private scheduleRateLimitPoll(): void {
    const waitTime = this.rateLimiter.getTimeUntilNextSlot();
    this.schedulePoll(Math.max(waitTime, 10));
  }

  /**
   * Arm the single pull-loop wake-up. `delay` is a constant, the validated `drainDelay`,
   * a pull-error backoff (<= 30 s) or a rate-limit wait that can exceed the native timer
   * limit (`limiter.duration`, `rateLimit(ms)`): `safeTimeout` honours it exactly
   * instead of re-polling every millisecond.
   */
  private schedulePoll(delay: number): void {
    if (!this.running || this._closing || this.closed) return;
    const deadline = Date.now() + delay;
    if (this.pollTimer !== null && this.pollDeadline !== null && this.pollDeadline <= deadline) {
      return;
    }
    this.clearPollTimer();

    const timer = safeTimeout(() => {
      if (this.pollTimer !== timer) return;
      this.pollTimer = null;
      this.pollDeadline = null;
      this.poll();
    }, delay);
    this.pollTimer = timer;
    this.pollDeadline = deadline;
  }

  /**
   * A failed pull: a thrown transport error or a permanent broker refusal (a transient
   * one never gets here: `doPullBatch` reads it as no job, `QUIET_REFUSAL`). Retry after
   * 100 ms doubling to 30 s, then report it with `context: 'pull'` (`reportPullFailure`,
   * `PullFailureLog`): as `error` to an attached listener (one that throws is logged);
   * without one, a permanent failure is logged at most once a minute and a transient
   * thrown error (a timeout, a lost connection) stays quiet. No unheard `error` is
   * emitted, so a refusal never crashes the process, and the retry is armed first.
   */
  protected handlePullError(errorValue: unknown): void {
    this.consecutiveErrors++;
    const error = errorValue instanceof Error ? errorValue : new Error(String(errorValue));
    const backoffMs = Math.min(
      WORKER_CONSTANTS.BASE_BACKOFF_MS * Math.pow(2, this.consecutiveErrors - 1),
      WORKER_CONSTANTS.MAX_BACKOFF_MS
    );
    this.schedulePoll(backoffMs);
    this.reportPullFailure(
      Object.assign(error, {
        queue: this.name,
        consecutiveErrors: this.consecutiveErrors,
        context: 'pull',
      })
    );
  }

  protected abstract startJob(delivery: WorkerDelivery): boolean;
  protected abstract getPullConfig(): PullConfig;
}
