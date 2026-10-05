import { assertDuration } from '../../shared/durations';

/** Queue Manager configuration. */
export interface QueueManagerConfig {
  dataPath?: string;
  maxCompletedJobs?: number;
  /** Delete retained completed jobs after this age; null/undefined disables automatic retention. */
  completedRetentionMs?: number | null;
  maxJobResults?: number;
  maxJobLogs?: number;
  maxCustomIds?: number;
  maxWaitingDeps?: number;
  /** Maximum queue label values emitted in one Prometheus scrape; zero disables them. */
  maxPrometheusQueues?: number;
  /** Maximum retained lifecycle events per queue. */
  maxQueueEvents?: number;
  /** Maximum retained one-minute metric buckets per queue and terminal state. */
  maxMetricDataPoints?: number;
  // The five background periods below must each be a finite number of milliseconds
  // >= 1 (undefined keeps the default); anything else throws a RangeError or TypeError
  // from the constructor. Periods above 2^31 - 1 ms are honoured, not shortened.
  /** Memory-cleanup period (default 10000). */
  cleanupIntervalMs?: number;
  /** Retry delay after a processing-timeout transition fails (default 5000). */
  jobTimeoutCheckMs?: number;
  /** Dependency safety-net period (default 30000). */
  dependencyCheckMs?: number;
  /** Stall-detection and lock-expiration period (default 5000). */
  stallCheckMs?: number;
  /** DLQ maintenance period (default 60000). */
  dlqMaintenanceMs?: number;
  validateWebhookUrls?: boolean;
}

export const DEFAULT_CONFIG = {
  maxCompletedJobs: 50_000,
  completedRetentionMs: null as number | null,
  maxJobResults: 10_000,
  maxJobLogs: 10_000,
  maxCustomIds: 50_000,
  maxWaitingDeps: 10_000,
  maxPrometheusQueues: 100,
  maxQueueEvents: 10_000,
  maxMetricDataPoints: 20_160,
  cleanupIntervalMs: 10_000,
  jobTimeoutCheckMs: 5_000,
  dependencyCheckMs: 30_000,
  stallCheckMs: 5_000,
  dlqMaintenanceMs: 60_000,
};

export function normalizeCompletedRetentionMs(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return null;
  const normalized = Math.floor(value);
  return Number.isSafeInteger(normalized) ? normalized : null;
}

/** The config fields that are timer periods or retry delays. */
const BACKGROUND_PERIODS = [
  'cleanupIntervalMs',
  'jobTimeoutCheckMs',
  'dependencyCheckMs',
  'stallCheckMs',
  'dlqMaintenanceMs',
] as const;

/**
 * Merge `config` over DEFAULT_CONFIG for the QueueManager constructor. Each background
 * period must be a finite number of milliseconds >= 1 (`undefined` keeps the default);
 * NaN, 0, negatives, Infinity and non-numbers throw a RangeError or TypeError naming the
 * option (`QueueManager: stallCheckMs must be ...`) instead of becoming a 1 ms interval.
 * Periods above the native timer limit are valid: the intervals use `safeInterval`.
 */
export function resolveQueueManagerConfig(
  config: QueueManagerConfig
): typeof DEFAULT_CONFIG & { dataPath?: string } {
  const resolved = {
    ...DEFAULT_CONFIG,
    ...config,
    completedRetentionMs: normalizeCompletedRetentionMs(config.completedRetentionMs),
  };
  for (const field of BACKGROUND_PERIODS) {
    const value = config[field];
    resolved[field] =
      value === undefined
        ? DEFAULT_CONFIG[field]
        : assertDuration(value, `QueueManager: ${field}`, { min: 1 });
  }
  return resolved;
}
