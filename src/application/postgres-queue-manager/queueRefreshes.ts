import { assertDuration } from '../../shared/durations';
import { safeTimeout, type SafeTimer } from '../../shared/timers';
import { POSTGRES_MAX_RETRY_DELAY_MS } from '../../infrastructure/persistence/postgres/maintenanceSchedule';

/** Reload one queue's read model; false when a concurrent event made the load stale. */
type QueueRefresh = (queue: string) => Promise<boolean>;
type QueueRefreshReporter = (queue: string, error: unknown) => void;

interface PendingPause {
  readonly timer: SafeTimer;
  readonly resolve: () => void;
}

/**
 * Coalesced full-queue refreshes of the local PostgreSQL read model, retried until one
 * applies.
 *
 * One loop runs per dirty queue. A load made stale by a concurrent event waits
 * `retryDelayMs` before reloading; a failed load waits `retryDelayMs`, then doubles up
 * to 1 s. The manager passes `postgresRetryDelayMs`: the poll interval, capped at 1 s,
 * so a long `pollIntervalMs` cannot keep a queue's read model stale. Every wait is a
 * cancellable `safeTimeout` that `stop()` ends at once: shutdown never sleeps one out.
 */
export class PostgresQueueRefreshes {
  private readonly loops = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private readonly pauses = new Set<PendingPause>();
  private stopped = false;

  constructor(
    /** The store's readiness; loops start only after it resolves. */
    private readonly ready: () => Promise<void>,
    private readonly refresh: QueueRefresh,
    private readonly report: QueueRefreshReporter,
    private readonly retryDelayMs: number
  ) {
    assertDuration(retryDelayMs, 'PostgresQueueRefreshes: retryDelayMs');
  }

  /** Mark `queue` stale again, for the loop that is reloading it. */
  markDirty(queue: string): void {
    this.dirty.add(queue);
  }

  /** Reload `queue` once the store is ready, coalescing with a loop already running. */
  schedule(queue: string): void {
    if (this.stopped) return;
    this.dirty.add(queue);
    if (this.loops.has(queue)) return;
    const loop = this.ready()
      .then(() => this.run(queue))
      .catch(() => {
        this.dirty.delete(queue);
      })
      .finally(() => {
        this.loops.delete(queue);
        if (this.dirty.has(queue)) this.schedule(queue);
      });
    this.loops.set(queue, loop);
  }

  /** Stop admission, drop dirty markers and end every pending wait. */
  stop(): void {
    this.stopped = true;
    this.dirty.clear();
    for (const pause of [...this.pauses]) {
      pause.timer.clear();
      pause.resolve();
    }
  }

  /** Settles once every loop started so far has finished. */
  settled(): Promise<unknown> {
    return Promise.allSettled([...this.loops.values()]);
  }

  private async run(queue: string): Promise<void> {
    let retryDelay = this.retryDelayMs;
    while (!this.stopped && this.dirty.delete(queue)) {
      try {
        const applied = await this.refresh(queue);
        if (!applied && !this.stopped) await this.pause(this.retryDelayMs);
        this.report(queue, null);
        retryDelay = this.retryDelayMs;
      } catch (error) {
        this.report(queue, error);
        if (this.stopped) return;
        this.dirty.add(queue);
        await this.pause(retryDelay);
        retryDelay = Math.min(retryDelay * 2, POSTGRES_MAX_RETRY_DELAY_MS);
      }
    }
  }

  private pause(delayMs: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      let pause: PendingPause | null = null;
      const end = () => {
        if (pause) this.pauses.delete(pause);
        resolve();
      };
      pause = { timer: safeTimeout(end, delayMs), resolve: end };
      this.pauses.add(pause);
    });
  }
}
