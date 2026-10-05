/**
 * The numeric server settings, each defined once: where it is read from (env vars,
 * config-file key, `bunqueue start` flag), what it accepts, its default, what it
 * tolerated before 2.9.11 (`legacy`, kept with a warning) and the feature it belongs to
 * (`feature`: its errors only stop startup when that feature is in use). The env parser,
 * the config-file schema and the CLI flags all read this table, so the three sources of
 * a setting cannot drift apart. See docs/features/configuration.md.
 */

import {
  DEFAULTS as S3_DEFAULTS,
  MIN_BACKUP_INTERVAL_MS,
  MIN_BACKUP_RETENTION,
} from '../infrastructure/backup/s3BackupDefaults';
import { POSTGRES_MAX_SESSION_TIMEOUT_MS } from '../infrastructure/persistence/postgres/sessionLimits';
import {
  RATE_LIMIT_CLEANUP_SETTING,
  RATE_LIMIT_MAX_REQUESTS_SETTING,
  RATE_LIMIT_WINDOW_SETTING,
} from '../infrastructure/server/rateLimiter';
import {
  TCP_IDLE_TIMEOUT_SETTING,
  TCP_MAX_WRITE_QUEUE_SETTING,
} from '../infrastructure/server/tcp/constants';
import { LOCK_TIMEOUT_SETTING } from '../shared/lockTimeout';
import { WORKER_CLEANUP_INTERVAL_SETTING, WORKER_TIMEOUT_SETTING } from '../shared/workerTimeouts';
import type { WholeRule } from './numbers';
import type { NumericSetting } from './envSetting';

export { envNumber, envSource, type NumericSetting, type SettingFeature } from './envSetting';

const MS = 'milliseconds';
const PORT: WholeRule = { min: 0, max: 65_535 };
/**
 * PostgreSQL stores these session timeouts as a 32-bit integer of milliseconds. The same
 * number as the runtime timer limit (`MAX_TIMER_DELAY_MS`), for a different reason, so
 * it has its own constant.
 */
const POSTGRES_TIMEOUT: WholeRule = { unit: MS, min: 1, max: POSTGRES_MAX_SESSION_TIMEOUT_MS };

function settings<T extends Record<string, NumericSetting>>(table: T): T {
  return table;
}

/** A setting whose rule is exported by the runtime module that reads it lazily. */
function fromRuntime(
  runtime: {
    readonly env: string;
    readonly min: number;
    readonly fallback: number;
    readonly allowZero?: boolean;
    readonly invalid?: number;
    readonly unreadable?: number;
    readonly negative?: number;
  },
  unit: WholeRule['unit']
): NumericSetting & { readonly fallback: number } {
  const { invalid, unreadable, negative, allowZero } = runtime;
  const tolerant = invalid !== undefined || unreadable !== undefined || negative !== undefined;
  const legacy = tolerant ? { legacy: { invalid, unreadable, negative } } : {};
  return {
    env: [runtime.env],
    rule: { unit, min: runtime.min, ...(allowZero === true && { allowZero }) },
    fallback: runtime.fallback,
    ...legacy,
  };
}

/** A count 2.9.10 wrapped in `positiveInteger` / `nonNegativeInteger`: invalid means the default. */
function defaulting(
  setting: NumericSetting & { readonly fallback: number }
): NumericSetting & { readonly fallback: number } {
  return { ...setting, legacy: { invalid: setting.fallback } };
}

/**
 * A PostgreSQL setting (`BUNQUEUE_POSTGRES_<suffix>`, `storage.<key>`): tolerated like
 * `defaulting`, and only checked when the server uses PostgreSQL.
 */
function postgres(
  suffix: string,
  key: string,
  rule: WholeRule,
  fallback: number
): NumericSetting & { readonly fallback: number } {
  const setting = { env: [`BUNQUEUE_POSTGRES_${suffix}`], file: `storage.${key}`, rule, fallback };
  return { ...defaulting(setting), feature: 'postgres' };
}

export const SETTINGS = settings({
  // server: 2.9.10 handed the raw value to Bun.listen, so an invalid port stopped it too
  tcpPort: {
    env: ['TCP_PORT'],
    file: 'server.tcpPort',
    flag: '--tcp-port',
    rule: PORT,
    fallback: 6789,
    fileStrings: true,
  },
  httpPort: {
    env: ['HTTP_PORT'],
    file: 'server.httpPort',
    flag: '--http-port',
    rule: PORT,
    fallback: 6790,
    fileStrings: true,
  },
  // storage
  maxCompletedJobs: defaulting({
    env: ['BUNQUEUE_MAX_COMPLETED_JOBS', 'MAX_COMPLETED_JOBS'],
    file: 'storage.maxCompletedJobs',
    flag: '--max-completed-jobs',
    rule: { min: 1 },
    fallback: 50_000,
  }),
  /** Optional (null = off); invalid values mean "off" with a warning (`resolve.ts`). */
  completedRetentionMs: {
    env: ['BUNQUEUE_COMPLETED_RETENTION_MS', 'COMPLETED_RETENTION_MS'],
    file: 'storage.completedRetentionMs',
    flag: '--completed-retention-ms',
    rule: { unit: MS, min: 0 },
  },
  postgresPoolSize: postgres('POOL_SIZE', 'poolSize', { min: 1 }, 4),
  postgresLeaseDurationMs: postgres(
    'LEASE_DURATION_MS',
    'leaseDurationMs',
    { unit: MS, min: 1 },
    30_000
  ),
  postgresPollIntervalMs: postgres('POLL_INTERVAL_MS', 'pollIntervalMs', { unit: MS, min: 1 }, 250),
  postgresStatementTimeoutMs: postgres(
    'STATEMENT_TIMEOUT_MS',
    'statementTimeoutMs',
    POSTGRES_TIMEOUT,
    30_000
  ),
  postgresLockTimeoutMs: postgres('LOCK_TIMEOUT_MS', 'lockTimeoutMs', POSTGRES_TIMEOUT, 5_000),
  postgresIdleTransactionTimeoutMs: postgres(
    'IDLE_TRANSACTION_TIMEOUT_MS',
    'idleTransactionTimeoutMs',
    POSTGRES_TIMEOUT,
    30_000
  ),
  postgresMaxConcurrentOperations: postgres(
    'MAX_CONCURRENT_OPERATIONS',
    'maxConcurrentOperations',
    { min: 1 },
    16
  ),
  postgresMaxQueuedOperations: postgres(
    'MAX_QUEUED_OPERATIONS',
    'maxQueuedOperations',
    { min: 0 },
    128
  ),
  postgresMaxSnapshotJobs: postgres('MAX_SNAPSHOT_JOBS', 'maxSnapshotJobs', { min: 1 }, 100_000),
  postgresMaxSnapshotPayloadBytes: postgres(
    'MAX_SNAPSHOT_PAYLOAD_BYTES',
    'maxSnapshotPayloadBytes',
    { unit: 'bytes', min: 1 },
    256 * 1024 * 1024
  ),
  // telemetry and timeouts
  maxPrometheusQueues: defaulting({
    env: ['METRICS_MAX_QUEUES'],
    file: 'telemetry.maxPrometheusQueues',
    rule: { min: 0 },
    fallback: 100,
  }),
  shutdownTimeoutMs: {
    env: ['SHUTDOWN_TIMEOUT_MS'],
    file: 'timeouts.shutdown',
    rule: { unit: MS, min: 0 },
    fallback: 30_000,
    fileStrings: true,
  },
  /** 0 would arm a 1 ms stats loop; a sub-second period is allowed (2.9.10 honoured it). */
  statsIntervalMs: {
    env: ['STATS_INTERVAL_MS'],
    file: 'timeouts.stats',
    rule: { unit: MS, min: 1 },
    fallback: 300_000,
    fileStrings: true,
  },
  // Runtime-owned rules (src/shared/, src/infrastructure/server/): defined once next to
  // the lazy runtime accessor, so the server configuration and the runtime agree. The
  // config-file keys `timeouts.worker` / `timeouts.lock` are ignored (see schema.ts).
  workerTimeoutMs: fromRuntime(WORKER_TIMEOUT_SETTING, MS),
  lockTimeoutMs: fromRuntime(LOCK_TIMEOUT_SETTING, MS),
  workerCleanupIntervalMs: fromRuntime(WORKER_CLEANUP_INTERVAL_SETTING, MS),
  tcpIdleTimeoutMs: fromRuntime(TCP_IDLE_TIMEOUT_SETTING, MS),
  tcpMaxWriteQueueBytes: fromRuntime(TCP_MAX_WRITE_QUEUE_SETTING, TCP_MAX_WRITE_QUEUE_SETTING.unit),
  rateLimitWindowMs: fromRuntime(RATE_LIMIT_WINDOW_SETTING, MS),
  rateLimitMaxRequests: fromRuntime(
    RATE_LIMIT_MAX_REQUESTS_SETTING,
    RATE_LIMIT_MAX_REQUESTS_SETTING.unit
  ),
  rateLimitCleanupMs: fromRuntime(RATE_LIMIT_CLEANUP_SETTING, MS),
  // S3 backup: an invalid value disables the backup with an error (`backup.ts`)
  backupIntervalMs: {
    env: ['S3_BACKUP_INTERVAL'],
    file: 'backup.interval',
    rule: { unit: MS, min: MIN_BACKUP_INTERVAL_MS },
    fallback: S3_DEFAULTS.intervalMs,
    fileStrings: true,
  },
  backupRetention: {
    env: ['S3_BACKUP_RETENTION'],
    file: 'backup.retention',
    rule: { min: MIN_BACKUP_RETENTION },
    fallback: S3_DEFAULTS.retention,
    fileStrings: true,
  },
  // webhooks (env only; `webhooks.*` in the file is ignored): the count includes the first try
  webhookMaxRetries: { env: ['WEBHOOK_MAX_RETRIES'], rule: { min: 1 }, fallback: 3 },
  /** `abc` or `-1`: 2.9.10 slept NaN / a negative delay, i.e. retried at once. */
  webhookRetryDelayMs: {
    env: ['WEBHOOK_RETRY_DELAY_MS'],
    rule: { unit: MS, min: 0 },
    fallback: 1_000,
    legacy: { invalid: 0 },
  },
  // Cloud agent (env only); the interval is never applied (the cadence is adaptive)
  cloudIntervalMs: {
    env: ['BUNQUEUE_CLOUD_INTERVAL_MS'],
    rule: { unit: MS, min: 1 },
    fallback: 15_000,
    feature: 'cloudInterval',
  },
  cloudBufferSize: {
    env: ['BUNQUEUE_CLOUD_BUFFER_SIZE'],
    rule: { min: 1 },
    fallback: 720,
    feature: 'cloud',
  },
  cloudCircuitBreakerThreshold: {
    env: ['BUNQUEUE_CLOUD_CIRCUIT_BREAKER_THRESHOLD'],
    rule: { min: 1 },
    fallback: 5,
    feature: 'cloud',
  },
  cloudCircuitBreakerResetMs: {
    env: ['BUNQUEUE_CLOUD_CIRCUIT_BREAKER_RESET_MS'],
    rule: { unit: MS, min: 1 },
    fallback: 60_000,
    feature: 'cloud',
  },
  // monitoring thresholds (env only; 0 disables each one, -1 or `abc` is read as 0)
  queueIdleThresholdMs: monitoring('QUEUE_IDLE_THRESHOLD_MS', MS, 30_000),
  queueSizeThreshold: monitoring('QUEUE_SIZE_THRESHOLD', undefined, 0),
  workerOverloadThresholdMs: monitoring('WORKER_OVERLOAD_THRESHOLD_MS', MS, 30_000),
  memoryWarningMb: monitoring('MEMORY_WARNING_MB', 'megabytes', 0),
  storageWarningMb: monitoring('STORAGE_WARNING_MB', 'megabytes', 0),
});

/**
 * A monitoring threshold: 0 disables it. 2.9.10 skipped a check `<= 0` and never fired
 * one compared with NaN, so a negative or unreadable value means 0, with a warning.
 */
function monitoring(
  env: string,
  unit: WholeRule['unit'],
  fallback: number
): NumericSetting & { readonly fallback: number } {
  return { env: [env], rule: { unit, min: 0 }, fallback, legacy: { invalid: 0 } };
}
