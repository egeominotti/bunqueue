import type { Job, JobId, JobTimelineEntry } from '../../../domain/types/job';

export interface ActiveJobWrite {
  jobId: JobId;
  startedAt: number;
  timeline?: JobTimelineEntry[];
}

export interface CompletedJobWrite {
  jobId: JobId;
  completedAt: number;
  timeline?: JobTimelineEntry[];
}

/** One write of a scalar ACK loop: what `storeResult` or `markCompleted` would run. */
export type CompletionWrite =
  | { kind: 'result'; jobId: JobId; result: unknown }
  | { kind: 'complete'; jobId: JobId; completedAt: number; timeline: JobTimelineEntry[] };

/** Outcome of a committed completion write sequence: the failed write, if any. */
export type CompletionWriteOutcome = { failedAt: number; error: unknown } | null;

export type SqliteCriticalLossCallback = (jobs: Job[], lastError: Error, attempts: number) => void;

export interface SqliteCriticalLoss {
  jobs: Job[];
  error: string;
  attempts: number;
  at: number;
}

export interface SqliteConfig {
  path: string;
  walMode?: boolean;
  synchronous?: 'OFF' | 'NORMAL' | 'FULL';
  cacheSize?: number;
  writeBufferSize?: number;
  writeBufferFlushMs?: number;
  onCriticalLoss?: SqliteCriticalLossCallback;
}
