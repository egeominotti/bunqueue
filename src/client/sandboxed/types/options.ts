import type { SharedManager } from '../../manager';
import type { ConnectionOptions } from '../../types';

/**
 * Duration options are milliseconds, validated by the constructor: an invalid one
 * throws a TypeError or RangeError naming it. Long values, above 2^31 - 1 ms too,
 * are honoured exactly.
 */
export interface SandboxedWorkerOptions {
  processor: string;
  concurrency?: number;
  maxMemory?: number;
  /** Per-job timeout. Default 30000; `0` or `Infinity` disables it. */
  timeout?: number;
  autoRestart?: boolean;
  maxRestarts?: number;
  /** Wait while every thread is busy. Default 10; a finite number >= 1. */
  pollInterval?: number;
  manager?: SharedManager;
  connection?: ConnectionOptions;
  /** Lease renewal period. Default 5000 embedded, 10000 TCP; <= 0 disables, else >= 1. */
  heartbeatInterval?: number;
  /** Stop the pool after this long idle. Default 0; `0` or `Infinity` disables it. */
  idleTimeout?: number;
  /** Recycle a spare idle thread after this long. Default 30000; `0` or `Infinity` disables it. */
  idleRecycleMs?: number;
  autoStart?: boolean;
  /** Wait between queue checks while idle-stopped. Default 5000; a finite number >= 1. */
  autoStartPollMs?: number;
}

export interface RequiredSandboxedWorkerOptions {
  processor: string;
  concurrency: number;
  maxMemory: number;
  timeout: number;
  autoRestart: boolean;
  maxRestarts: number;
  pollInterval: number;
}
