/** Worker option types and shared constants. */

import type { TlsOption } from './connection.js';
import type { Job } from './job.js';
import type { Observability } from './observability.js';

export type Processor<T = unknown, R = unknown> = (job: Job<T>) => R | Promise<R>;

/**
 * Typed Worker event map: listeners registered via `on`/`once`/`off` for these
 * names get typed job/result/error parameters in strict mode. Unknown event
 * names fall back to a generic `(...args: unknown[])` overload.
 */
export interface WorkerEventMap<T = unknown, R = unknown> {
  /** Worker registered and pull loop started (replayed to late listeners). */
  ready: () => void;
  /** A job was pulled and handed to the processor. */
  active: (job: Job<T>) => void;
  /** Processor resolved AND the ACK reached the server. */
  completed: (job: Job<T>, result: R) => void;
  /** Processor threw AND the FAIL reached the server. */
  failed: (job: Job<T>, error: Error) => void;
  /** job.updateProgress() was called from the processor. */
  progress: (job: Job<T>, progress: number) => void;
  /** Connection/command error (pull loop, ACK/FAIL, heartbeat, ...). */
  error: (error: Error) => void;
  /** The queue went from busy to empty (no active jobs, nothing pulled). */
  drained: () => void;
  /** Cooperative cancel was requested for a locally active job. */
  cancelled: (info: { jobId: string; reason: string }) => void;
  /** close() finished. */
  closed: () => void;
}

export interface AckBatchOptions {
  /** Batch ACKs into ACKB round-trips (default false; opt-in for throughput). */
  enabled?: boolean;
  /** Max ACKs per batch (default 50); 0 or below sends every ACK at once. */
  maxSize?: number;
  /**
   * Max ms to hold a partial batch before flushing (default 5): finite; NaN or negative
   * flushes on the next timer tick.
   */
  maxDelayMs?: number;
}

export interface WorkerOptions extends Observability {
  host?: string;
  port?: number;
  token?: string;
  tls?: TlsOption;
  /**
   * Batch completed-job ACKs into ACKB commands for higher throughput under
   * load. Opt-in: the default (individual ACK per job) is unchanged.
   */
  ackBatch?: AckBatchOptions;
  /** Max jobs processed in parallel (default 4): a whole number >= 1. */
  concurrency?: number;
  /**
   * Max jobs fetched per PULLB (default 10, capped by free slots): clamped to [1, 1000]
   * (the server max); a non-finite or non-number value means the default.
   */
  batchSize?: number;
  /**
   * Server-side long-poll timeout in ms (default 5000): clamped to [0, 30000]; NaN means
   * the default. After an empty pull the worker pauses 50 ms with 0, 10 ms after a long poll.
   */
  pollTimeoutMs?: number;
  /** Job lock TTL in ms (default 30000): finite, >= 1. */
  lockTtlMs?: number;
  /**
   * Worker + job heartbeat interval in seconds (default 10). 0, negative, non-finite or
   * a non-number disables heartbeats (SDK rule); periods beyond the runtime timer limit
   * (about 24.8 days) are honoured.
   */
  heartbeatIntervalS?: number;
  /** Start the loop at construction (default true, mirrors the TS client). */
  autorun?: boolean;
  name?: string;
}

export const MAX_POLL_TIMEOUT_MS = 30_000;
/**
 * Pause after an empty pull, as the main client's polling loop: its `drainDelay`
 * default without a long poll (pollTimeoutMs 0), 10 ms after a long poll.
 */
export const EMPTY_PULL_DELAY_MS = 50;
export const LONG_POLL_REPOLL_MS = 10;
export const MAX_STACK_LINES = 20;
export const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 5000];

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
