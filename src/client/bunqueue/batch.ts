/**
 * Bunqueue — Batch Processing
 * Accumulates jobs and processes them in groups.
 *
 * The partial-batch timer is a `safeTimeout`: a timeout that fits the runtime's timer
 * range is one native timer (the per-batch cost is unchanged), and a longer one is
 * armed in chunks instead of firing after about 1 ms.
 */

import { safeTimeout, type SafeTimer } from '../../shared/timers';
import type { Job, FlowJobData, Processor } from '../types';
import type { BatchConfig } from './types';

interface BufferEntry<T, R> {
  job: Job<T & FlowJobData>;
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
    this.timeoutMs = config.timeout ?? 5000;
  }

  /** Build a Processor that buffers jobs into batches */
  buildProcessor(): Processor<T, R> {
    return (job: Job<T & FlowJobData>): Promise<R> => {
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

    const jobs = batch.map((b) => b.job as unknown as Job<T>);
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
