/**
 * Bunqueue Simple Mode — batch processing.
 * 1:1 port of src/client/bunqueue/batch.ts: accumulates jobs and processes
 * them in groups; flushes on size, on timeout, and on destroy (close).
 *
 * The partial-batch timer is a `safeTimeout`: a timeout that fits the runtime's timer
 * range is one native timer, and a longer one is armed in chunks instead of firing
 * after about 1 ms. As in 0.2.2, `size` is compared as given (0 flushes every job,
 * omitted or NaN flushes on `timeout` only) and a NaN or negative `timeout` flushes on
 * the next timer tick.
 */

import type { Job } from '../job.js';
import { legacyDelay } from '../legacy-coercion.js';
import { type SafeTimer, safeTimeout } from '../timing.js';
import type { Processor } from '../worker-types.js';
import type { BatchConfig } from './types.js';

interface BufferEntry<T, R> {
  job: Job<T>;
  resolve: (value: R) => void;
  reject: (err: Error) => void;
}

export class BatchAccumulator<T = unknown, R = unknown> {
  private readonly buffer: BufferEntry<T, R>[] = [];
  private timer: SafeTimer | null = null;
  private readonly config: BatchConfig<T, R>;
  /** Validated by the Bunqueue constructor; read once so the hot path does no lookups. */
  private readonly size: number;
  private readonly timeoutMs: number;

  constructor(config: BatchConfig<T, R>) {
    this.config = config;
    this.size = config.size;
    this.timeoutMs = legacyDelay(config.timeout ?? 5000, 'Bunqueue: batch.timeout');
  }

  /** Build a Processor that buffers jobs into batches. */
  buildProcessor(): Processor<T, R> {
    return (job: Job<T>): Promise<R> => {
      return new Promise<R>((resolve, reject) => {
        this.buffer.push({ job, resolve, reject });

        if (this.buffer.length >= this.size) {
          this.flush();
        } else if (!this.timer) {
          this.timer = safeTimeout(this.flushOnTimeout, this.timeoutMs);
        }
      });
    };
  }

  private readonly flushOnTimeout = (): void => {
    this.flush();
  };

  flush(): void {
    if (this.timer) {
      this.timer.clear();
      this.timer = null;
    }

    const batch = this.buffer.splice(0);
    if (batch.length === 0) return;

    const jobs = batch.map((b) => b.job);
    this.config.processor(jobs).then(
      (results) => {
        for (let i = 0; i < batch.length; i++) {
          batch[i].resolve(results[i] ?? (undefined as unknown as R));
        }
      },
      (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        for (const b of batch) {
          b.reject(error);
        }
      }
    );
  }

  destroy(): void {
    if (this.timer) {
      this.timer.clear();
      this.timer = null;
    }
    // Flush remaining
    if (this.buffer.length > 0) {
      this.flush();
    }
  }
}
