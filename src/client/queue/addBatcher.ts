/**
 * Add Batcher
 * Batches queue.add() calls for efficient TCP communication via PUSHB
 *
 * Strategy: if no flush is in-flight, send immediately (zero overhead for
 * sequential await). If a flush IS in-flight, buffer and send when it
 * completes or after maxDelayMs, whichever comes first. This gives both
 * zero-latency sequential adds AND automatic batching for concurrent adds.
 */

import { describeValue } from '../../shared/durations';
import { ceilAtLeast, coerceNumericString } from '../tcp/numeric';
import { safeTimeout, type SafeTimer } from '../../shared/timers';
import type { AutoBatchOptions, Job, JobOptions } from '../types';

/** Pending add entry with resolve/reject callbacks */
interface PendingAdd<T> {
  name: string;
  data: T;
  opts?: JobOptions;
  resolve: (job: Job<T>) => void;
  reject: (err: Error) => void;
}

/** Add batcher configuration */
export interface AddBatcherConfig {
  /** Max items before auto-flush (default: 50) */
  maxSize: number;
  /** Max delay in ms before auto-flush (default: 5) */
  maxDelayMs: number;
  /** Max pending items before overflow protection (default: 10000) */
  maxPending?: number;
}

/**
 * The batcher config of a Queue's `autoBatch` option, or null when batching is off.
 * Never throws: every value keeps the result 2.9.10 gave it. A numeric string is that
 * number. `maxSize` is the threshold of `pending >= maxSize`: a value below 1 flushes
 * every add (as 1 does), a fraction rounds up, and Infinity, NaN, a non-number or a
 * value above `Number.MAX_SAFE_INTEGER` never flushes by size (Infinity). `maxDelayMs`
 * is a one-shot window: a negative value, NaN, Infinity or a non-number is 0, the
 * immediate flush 2.9.10's timer gave it (~1 ms); a finite window, even beyond the
 * native timer limit, is honoured by `safeTimeout`.
 */
export function resolveAutoBatchConfig(
  autoBatch: AutoBatchOptions | undefined
): AddBatcherConfig | null {
  if (!resolveAutoBatchEnabled(autoBatch?.enabled)) return null;
  const size = coerceNumericString(autoBatch?.maxSize ?? 50);
  const maxSize =
    typeof size === 'number' && size < Infinity && Number.isSafeInteger(Math.ceil(size))
      ? ceilAtLeast(size, 1)
      : typeof size === 'number' && size < 0
        ? 1
        : Infinity;
  const delay = coerceNumericString(autoBatch?.maxDelayMs ?? 5);
  const maxDelayMs = typeof delay === 'number' && delay >= 0 && delay < Infinity ? delay : 0;
  return { maxSize, maxDelayMs };
}

/**
 * `autoBatch.enabled`: a boolean, or a recognized word or number (`'false'`, `0`,
 * `'0'`, `'true'`, `1`, `'1'`, any case) with its meaning. Anything else keeps batching
 * on, as 2.9.10 did (it disabled batching only for `false`), with one warning.
 */
function resolveAutoBatchEnabled(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'boolean') return value;
  const word = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (word === 'false' || word === '0' || word === 0) return false;
  if (word === 'true' || word === '1' || word === 1) return true;
  try {
    console.warn(
      `[bunqueue] Queue: autoBatch.enabled should be a boolean (got ${describeValue(value)}); ` +
        'auto-batching stays enabled'
    );
  } catch {
    // A broken console cannot fail the constructor.
  }
  return true;
}

/** Flush callback that sends a batch and returns Job objects */
export type FlushCallback<T> = (
  jobs: Array<{ name: string; data: T; opts?: JobOptions }>
) => Promise<Job<T>[]>;

/**
 * Batches add() operations into addBulk() calls for efficient TCP throughput.
 *
 * - If no flush is in-flight: flushes immediately (no timer delay)
 * - If a flush IS in-flight: buffers until maxSize or maxDelayMs
 * - After each flush completes: drains any accumulated buffer immediately
 */
export class AddBatcher<T> {
  private readonly maxPending: number;
  private readonly pending: PendingAdd<T>[] = [];
  private timer: SafeTimer | null = null;
  private readonly config: AddBatcherConfig;
  private readonly flushCb: FlushCallback<T>;
  private stopped = false;
  private flushing = false;
  private readonly inFlightFlushes: Set<Promise<void>> = new Set();

  constructor(config: AddBatcherConfig, flushCb: FlushCallback<T>) {
    this.config = config;
    this.maxPending = config.maxPending ?? 10000;
    this.flushCb = flushCb;
  }

  /** Enqueue an add() call, returns Promise<Job<T>> resolved after flush */
  enqueue(name: string, data: T, opts?: JobOptions): Promise<Job<T>> {
    return new Promise<Job<T>>((resolve, reject) => {
      if (this.stopped) {
        reject(new Error('AddBatcher stopped'));
        return;
      }

      // Overflow protection: drop oldest 10% if buffer is full
      if (this.pending.length >= this.maxPending) {
        const dropped = this.pending.splice(0, Math.floor(this.maxPending * 0.1));
        for (const entry of dropped) {
          entry.reject(new Error('Add buffer overflow - oldest entries dropped'));
        }
      }

      this.pending.push({ name, data, opts, resolve, reject });

      if (this.pending.length >= this.config.maxSize) {
        // Size threshold reached - flush now
        this.triggerFlush();
      } else if (!this.flushing) {
        // No flush in-flight - flush immediately (zero latency for sequential)
        this.triggerFlush();
      } else {
        // Flush in-flight - start timer, items will batch up naturally
        // A safe timer: a window above 2^31 - 1 ms must not fire after ~1 ms.
        this.timer ??= safeTimeout(() => {
          this.timer = null;
          this.triggerFlush();
        }, this.config.maxDelayMs);
      }
    });
  }

  /** Start a flush and track it */
  private triggerFlush(): void {
    if (this.timer) {
      this.timer.clear();
      this.timer = null;
    }
    const flushPromise = this.doFlush().catch((err: unknown) => {
      console.error('[bunqueue] Flush failed:', err instanceof Error ? err.message : String(err));
    });
    this.inFlightFlushes.add(flushPromise);
    void flushPromise.finally(() => this.inFlightFlushes.delete(flushPromise));
  }

  /** Flush pending adds, then drain any items that accumulated during flush */
  private async doFlush(): Promise<void> {
    if (this.pending.length === 0) return;
    this.flushing = true;

    try {
      while (this.pending.length > 0 && !this.stopped) {
        await this.flushOnce();
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Flush all pending adds as a single addBulk call */
  async flush(): Promise<void> {
    await this.doFlush();
  }

  /** Send one batch */
  private async flushOnce(): Promise<void> {
    const batch = this.pending.splice(0, this.pending.length);
    if (batch.length === 0) return;

    if (this.timer) {
      this.timer.clear();
      this.timer = null;
    }

    try {
      const jobs = await this.flushCb(
        batch.map((entry) => ({ name: entry.name, data: entry.data, opts: entry.opts }))
      );

      for (let i = 0; i < batch.length; i++) {
        batch[i].resolve(jobs[i]);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      for (const entry of batch) {
        entry.reject(error);
      }
    }
  }

  /** Stop the batcher - rejects remaining pending entries */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      this.timer.clear();
      this.timer = null;
    }
    const error = new Error('AddBatcher stopped');
    const remaining = this.pending.splice(0, this.pending.length);
    for (const entry of remaining) {
      entry.reject(error);
    }
  }

  /** Wait for all in-flight flush operations to complete */
  async waitForInFlight(): Promise<void> {
    if (this.inFlightFlushes.size === 0) return;
    await Promise.all(this.inFlightFlushes);
  }

  /** Check if there are pending adds */
  hasPending(): boolean {
    return this.pending.length > 0;
  }
}
