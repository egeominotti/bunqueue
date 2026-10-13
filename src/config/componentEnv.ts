/**
 * Env settings read by components that also run in embedded mode: webhook delivery,
 * the monitoring thresholds and the removed-result retention of the embedded
 * QueueManager (`src/client/manager.ts`). The components read them when they are created
 * (not at module load), and `resolveServerConfig` reads them through the same
 * functions (the removed-result settings through the same `envNumber` calls, after the
 * config file), so a server with an invalid value stops at startup and an embedded
 * QueueManager throws when it is constructed, both with an error naming the variable.
 * A tolerated value (a negative threshold, read as 0 = disabled, as 2.9.10 skipped
 * `<= 0`) is a warning: in the server's startup list, or logged once by the component.
 */

import { ConfigIssues, type Env } from './numbers';
import { SETTINGS, envNumber } from './settings';
import { warnConfigOnce } from './warnings';

/** How a failed webhook delivery is retried. */
export interface WebhookDelivery {
  /** Delivery attempts per event, the first try included (>= 1). */
  readonly maxRetries: number;
  /** Base delay; the wait before attempt n + 1 is `retryDelayMs * n` (>= 0). */
  readonly retryDelayMs: number;
}

/** The removed-result retention of a QueueManager (see `src/application/removedResults.ts`). */
export interface RemovedResultRetention {
  /** How long a record answers, in ms (default 60000); 0 disables the record. */
  readonly removedResultRetentionMs: number;
  /** Maximum records, counted in jobs, not bytes (default 1000); 0 disables the record. */
  readonly maxRemovedResults: number;
}

/** Thresholds of the dashboard monitoring events; 0 disables each one (-1 reads as 0). */
export interface MonitoringThresholds {
  readonly queueIdleMs: number;
  readonly queueSize: number;
  readonly workerOverloadMs: number;
  readonly memoryWarningMb: number;
  readonly storageWarningMb: number;
}

/**
 * Run `read` with `issues`, or with a private collector that logs its warnings once and
 * throws at the end.
 */
function collect<T>(issues: ConfigIssues | undefined, read: (issues: ConfigIssues) => T): T {
  const target = issues ?? new ConfigIssues();
  const value = read(target);
  if (issues === undefined) {
    for (const warning of target.warnings) warnConfigOnce(warning);
    target.throwIfAny();
  }
  return value;
}

/** `WEBHOOK_MAX_RETRIES` and `WEBHOOK_RETRY_DELAY_MS`, or their defaults (3, 1000). */
export function readWebhookDelivery(env: Env = Bun.env, issues?: ConfigIssues): WebhookDelivery {
  return collect(issues, (target) => ({
    maxRetries: envNumber(SETTINGS.webhookMaxRetries, env, target),
    retryDelayMs: envNumber(SETTINGS.webhookRetryDelayMs, env, target),
  }));
}

/** `QUEUE_IDLE_THRESHOLD_MS`, `QUEUE_SIZE_THRESHOLD`, `WORKER_OVERLOAD_THRESHOLD_MS`, `*_WARNING_MB`. */
export function readMonitoringThresholds(
  env: Env = Bun.env,
  issues?: ConfigIssues
): MonitoringThresholds {
  return collect(issues, (target) => ({
    queueIdleMs: envNumber(SETTINGS.queueIdleThresholdMs, env, target),
    queueSize: envNumber(SETTINGS.queueSizeThreshold, env, target),
    workerOverloadMs: envNumber(SETTINGS.workerOverloadThresholdMs, env, target),
    memoryWarningMb: envNumber(SETTINGS.memoryWarningMb, env, target),
    storageWarningMb: envNumber(SETTINGS.storageWarningMb, env, target),
  }));
}

/**
 * `BUNQUEUE_REMOVED_RESULT_RETENTION_MS` and `BUNQUEUE_MAX_REMOVED_RESULTS`, or their
 * defaults (60000, 1000), parsed exactly as the server parses them (`resolveServerConfig`,
 * where a config-file value wins): a value with no number or below 0 means the default,
 * with a warning; a value `parseInt` misread (`1e12`, `5s`) is an error.
 */
export function readRemovedResultRetention(
  env: Env = Bun.env,
  issues?: ConfigIssues
): RemovedResultRetention {
  return collect(issues, (target) => ({
    removedResultRetentionMs: envNumber(SETTINGS.removedResultRetentionMs, env, target),
    maxRemovedResults: envNumber(SETTINGS.maxRemovedResults, env, target),
  }));
}
