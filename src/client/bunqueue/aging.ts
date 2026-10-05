/**
 * Bunqueue — Priority Aging
 * Automatically boosts priority of old waiting jobs.
 *
 * The tick is a `safeInterval`: an interval longer than the runtime's timer limit
 * (about 24.8 days) is re-armed in chunks instead of ticking every millisecond. At most
 * one tick runs at a time: a firing that finds the previous tick still waiting on its
 * queries or updates is dropped, not queued. Aging is best-effort: a tick whose job
 * queries fail is skipped (the next tick retries), so a transient error never surfaces
 * as an unhandled rejection.
 */

import { safeInterval, type SafeTimer } from '../../shared/timers';
import type { Queue } from '../queue/queue';
import type { PriorityAgingConfig } from './types';

/** A failed tick is skipped; the interval keeps running. */
const skipFailedTick = (): void => undefined;

export class PriorityAger<T = unknown> {
  private timer: SafeTimer | null = null;
  private generation = 0;
  /** The tick in progress, of any generation; at most one runs at a time. */
  private inFlight: Promise<void> | null = null;
  private readonly queue: Queue<T>;
  /** Validated by the Bunqueue constructor and read once. */
  private readonly interval: number;
  private readonly minAge: number;
  private readonly boost: number;
  private readonly maxPriority: number;
  private readonly maxScan: number;

  constructor(config: PriorityAgingConfig, queue: Queue<T>) {
    this.queue = queue;
    this.interval = config.interval ?? 60000;
    this.minAge = config.minAge ?? 60000;
    this.boost = config.boost ?? 1;
    this.maxPriority = config.maxPriority ?? 100;
    this.maxScan = config.maxScan ?? 100;
  }

  start(): void {
    if (this.timer !== null) return;
    const generation = ++this.generation;
    this.timer = safeInterval(() => this.runTick(generation), this.interval);
  }

  /**
   * Start a tick unless one is still in flight. A firing that finds one is dropped, so
   * slow queries never overlap ticks (each would re-read and boost the same jobs again)
   * and dropped firings cannot burst once it settles: the next tick starts on the next
   * firing. A tick left over from before destroy() counts too; it begins no new
   * priority change after its pending call returns.
   */
  private runTick(generation: number): void {
    if (generation !== this.generation || this.inFlight !== null) return;
    const run: Promise<void> = this.tick(generation)
      .catch(skipFailedTick)
      .finally(() => {
        if (this.inFlight === run) this.inFlight = null;
      });
    this.inFlight = run;
  }

  private async tick(generation: number): Promise<void> {
    if (generation !== this.generation) return;
    const { minAge, boost, maxPriority, maxScan } = this;

    // Get both waiting and prioritized jobs (jobs with priority > 0 are "prioritized")
    const [waiting, prioritized] = await Promise.all([
      this.queue.getWaitingAsync(0, maxScan),
      this.queue.getJobsAsync({ state: 'prioritized', start: 0, end: maxScan }),
    ]);
    if (generation !== this.generation) return;
    const jobs = [...waiting, ...prioritized];
    const now = Date.now();

    for (const job of jobs) {
      if (generation !== this.generation) return;
      const age = now - job.timestamp;
      if (age >= minAge && job.priority < maxPriority) {
        const newPriority = Math.min(job.priority + boost, maxPriority);
        try {
          await this.queue.changeJobPriority(job.id, {
            priority: newPriority,
          });
        } catch {
          // Best-effort — job may have been processed
        }
      }
    }
  }

  destroy(): void {
    this.generation++;
    const timer = this.timer;
    this.timer = null;
    timer?.clear();
  }
}
