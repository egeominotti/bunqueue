/**
 * bunqueue Config Resolver
 * Merges config file + env vars + defaults (CLI flags are merged into the file
 * config by `bunqueue start`; config file wins over env). Every value is validated:
 * a setting the server cannot use stops startup with a `ConfigError` naming the env var
 * or the config-file key, and every problem is reported at once. A value 2.9.10 ran
 * with (an ignored word, a documented fallback, a setting of a feature that is off) is
 * a warning in `configWarnings` instead, and keeps the value 2.9.10 used.
 */

import type { BunqueueConfig } from './types';
import { normalizeCompletedRetentionMs } from '../application/types/config';
import { parseTokenList } from './auth';
import { backupSettings } from './backup';
import { cloudIdentity, cloudNumbers, cloudSwitches } from './cloud';
import { readMonitoringThresholds, readWebhookDelivery } from './componentEnv';
import { envOptionalDuration } from './envSetting';
import { resolveLogging } from './logging';
import { ConfigIssues, type Env } from './numbers';
import { normalizeConfigFile } from './schema';
import { SETTINGS, envNumber, type NumericSetting } from './settings';
import { selectStorage, type StorageDriver } from './storage';
import { envBoolean, type LogFormat, type LogLevelWord } from './text';
import { markConfigWarningsReported } from './warnings';

export { resolveBackupConfig } from './backup';
export { resolveCloudConfig } from './cloud';
export { ConfigError } from './numbers';

/** Fully resolved server configuration */
export interface ResolvedConfig {
  tcpPort: number;
  httpPort: number;
  hostname: string;
  tcpSocketPath: string | undefined;
  httpSocketPath: string | undefined;
  tlsCertFile: string | undefined;
  tlsKeyFile: string | undefined;
  authTokens: string[];
  dataPath: string | undefined;
  storageDriver: StorageDriver;
  postgresUrl: string | undefined;
  postgresNamespace: string;
  postgresBrokerId: string | undefined;
  postgresPoolSize: number;
  postgresLeaseDurationMs: number;
  postgresPollIntervalMs: number;
  postgresStatementTimeoutMs: number;
  postgresLockTimeoutMs: number;
  postgresIdleTransactionTimeoutMs: number;
  postgresMaxConcurrentOperations: number;
  postgresMaxQueuedOperations: number;
  postgresMaxSnapshotJobs: number;
  postgresMaxSnapshotPayloadBytes: number;
  maxCompletedJobs: number;
  completedRetentionMs: number | null;
  corsOrigins: string[];
  requireAuthForMetrics: boolean;
  maxPrometheusQueues: number;
  /** S3_BACKUP_ENABLED / `backup.enabled`; an enabled backup that cannot run logs why. */
  s3BackupEnabled: boolean;
  shutdownTimeoutMs: number;
  statsIntervalMs: number;
  /** WEBHOOK_MAX_RETRIES > 3 (first try included); the file's `webhooks.*` is ignored. */
  webhookMaxRetries: number;
  /** WEBHOOK_RETRY_DELAY_MS > 1000 ms; the file's `webhooks.*` is ignored. */
  webhookRetryDelayMs: number;
  /** WORKER_TIMEOUT_MS > 30000 ms; the file's `timeouts.worker` is ignored. */
  workerTimeoutMs: number;
  /** LOCK_TIMEOUT_MS > 5000 ms; the file's `timeouts.lock` is ignored. */
  lockTimeoutMs: number;
  /** `logging.level` > LOG_LEVEL > info; undefined keeps the logger's level (see `logging.ts`). */
  logLevel: LogLevelWord | undefined;
  /** `logging.format` > LOG_FORMAT > text; `json` turns JSON output on (see `logging.ts`). */
  logFormat: LogFormat;
  /** Non-fatal findings (unknown keys, tolerated values), logged by `bootServer`. */
  configWarnings: string[];
}

/* eslint-disable complexity -- pure config mapping, no real branching logic */

/**
 * Resolve server config: config file > env vars > defaults. Throws a `ConfigError`
 * when a setting the server would use is invalid, including the env-only settings of
 * the webhook, monitoring, TCP and rate-limit components, so a bad value stops startup
 * before anything binds. Settings of PostgreSQL, Cloud and S3 backup only stop it when
 * that feature is in use; an enabled S3 backup that cannot run never does (the backup
 * scheduler logs why, see `backup.ts`).
 */
export function resolveServerConfig(
  fileConfig: BunqueueConfig | null,
  env: Env = Bun.env
): ResolvedConfig {
  const issues = new ConfigIssues();
  const fc = normalizeConfigFile(fileConfig, issues);
  const num = (setting: NumericSetting & { readonly fallback: number }, fileValue?: number) =>
    fileValue ??
    envNumber(setting, env, setting.feature ? issues.forFeature(setting.feature) : issues);
  const storage = fc?.storage;
  const { storageDriver, dataPath, postgresUrl } = selectStorage(storage, env, issues);
  const completedRetentionMs =
    storage?.completedRetentionMs !== undefined
      ? storage.completedRetentionMs
      : envOptionalDuration(SETTINGS.completedRetentionMs, env, issues);
  // Always parsed: the webhook manager reads these env vars on its own.
  const webhookEnv = readWebhookDelivery(env, issues);
  const logging = resolveLogging(fc?.logging, env, issues);
  const backup = backupSettings(fc?.backup, env, issues);
  // An enabled backup reports its problems itself (configErrors), at error level.
  if (!backup.settings.enabled) {
    for (const problem of backup.problems)
      issues.warn(`${problem}; ignored: S3 backup is disabled`);
  }

  const resolved: ResolvedConfig = {
    tcpPort: num(SETTINGS.tcpPort, fc?.server?.tcpPort),
    httpPort: num(SETTINGS.httpPort, fc?.server?.httpPort),
    hostname: fc?.server?.host ?? env.HOST ?? '0.0.0.0',
    tcpSocketPath: fc?.server?.tcpSocketPath ?? env.TCP_SOCKET_PATH,
    httpSocketPath: fc?.server?.httpSocketPath ?? env.HTTP_SOCKET_PATH,
    tlsCertFile: fc?.server?.tlsCertFile ?? env.TLS_CERT_FILE,
    tlsKeyFile: fc?.server?.tlsKeyFile ?? env.TLS_KEY_FILE,
    // Trimmed, stray commas dropped; set but tokenless ("," or " ") is an error.
    authTokens:
      fc?.auth?.tokens ?? issues.check(() => parseTokenList('AUTH_TOKENS', env.AUTH_TOKENS), []),
    dataPath,
    storageDriver,
    postgresUrl,
    postgresNamespace: storage?.namespace ?? env.BUNQUEUE_POSTGRES_NAMESPACE ?? 'default',
    postgresBrokerId: storage?.brokerId ?? env.BUNQUEUE_BROKER_ID,
    postgresPoolSize: num(SETTINGS.postgresPoolSize, storage?.poolSize),
    postgresLeaseDurationMs: num(SETTINGS.postgresLeaseDurationMs, storage?.leaseDurationMs),
    postgresPollIntervalMs: num(SETTINGS.postgresPollIntervalMs, storage?.pollIntervalMs),
    postgresStatementTimeoutMs: num(
      SETTINGS.postgresStatementTimeoutMs,
      storage?.statementTimeoutMs
    ),
    postgresLockTimeoutMs: num(SETTINGS.postgresLockTimeoutMs, storage?.lockTimeoutMs),
    postgresIdleTransactionTimeoutMs: num(
      SETTINGS.postgresIdleTransactionTimeoutMs,
      storage?.idleTransactionTimeoutMs
    ),
    postgresMaxConcurrentOperations: num(
      SETTINGS.postgresMaxConcurrentOperations,
      storage?.maxConcurrentOperations
    ),
    postgresMaxQueuedOperations: num(
      SETTINGS.postgresMaxQueuedOperations,
      storage?.maxQueuedOperations
    ),
    postgresMaxSnapshotJobs: num(SETTINGS.postgresMaxSnapshotJobs, storage?.maxSnapshotJobs),
    postgresMaxSnapshotPayloadBytes: num(
      SETTINGS.postgresMaxSnapshotPayloadBytes,
      storage?.maxSnapshotPayloadBytes
    ),
    maxCompletedJobs: num(SETTINGS.maxCompletedJobs, storage?.maxCompletedJobs),
    completedRetentionMs: normalizeCompletedRetentionMs(completedRetentionMs),
    corsOrigins: fc?.cors?.origins ?? env.CORS_ALLOW_ORIGIN?.split(',').filter(Boolean) ?? [],
    requireAuthForMetrics:
      fc?.auth?.requireAuthForMetrics ?? envBoolean('METRICS_AUTH', env, false, issues),
    maxPrometheusQueues: num(SETTINGS.maxPrometheusQueues, fc?.telemetry?.maxPrometheusQueues),
    s3BackupEnabled: backup.settings.enabled,
    shutdownTimeoutMs: num(SETTINGS.shutdownTimeoutMs, fc?.timeouts?.shutdown),
    statsIntervalMs: num(SETTINGS.statsIntervalMs, fc?.timeouts?.stats),
    webhookMaxRetries: webhookEnv.maxRetries,
    webhookRetryDelayMs: webhookEnv.retryDelayMs,
    workerTimeoutMs: num(SETTINGS.workerTimeoutMs),
    lockTimeoutMs: num(SETTINGS.lockTimeoutMs),
    logLevel: logging.logLevel,
    logFormat: logging.logFormat,
    configWarnings: issues.warnings,
  };
  issues.settle('postgres', storageDriver === 'postgres', 'the server does not use PostgreSQL');
  if (resolved.requireAuthForMetrics && resolved.authTokens.length === 0) {
    const source =
      fc?.auth?.requireAuthForMetrics === undefined ? 'METRICS_AUTH' : 'auth.requireAuthForMetrics';
    issues.warn(
      `${source} requires a token on /prometheus but no auth token is configured (AUTH_TOKENS or auth.tokens): /prometheus answers 503 until one is`
    );
  }

  // Settings other components read on their own: validated here so that a typo
  // stops startup, before storage opens, instead of surfacing later (or never).
  for (const setting of [
    SETTINGS.workerCleanupIntervalMs,
    SETTINGS.tcpIdleTimeoutMs,
    SETTINGS.tcpMaxWriteQueueBytes,
    SETTINGS.rateLimitWindowMs,
    SETTINGS.rateLimitMaxRequests,
    SETTINGS.rateLimitCleanupMs,
  ]) {
    envNumber(setting, env, issues);
  }
  readMonitoringThresholds(env, issues);
  const cloud = cloudIdentity(fc?.cloud, env);
  cloudNumbers(env, issues);
  cloudSwitches(env, issues);
  const cloudOn = Boolean(cloud.url && cloud.apiKey && cloud.instanceId);
  issues.settle('cloud', cloudOn, 'bunqueue Cloud is not configured');
  issues.settle('cloudInterval', false, 'the Cloud upload interval is adaptive, never this value');
  // Components that read the same variables later must not print these twice.
  markConfigWarningsReported(issues.warnings);
  issues.throwIfAny();
  return resolved;
}

/* eslint-enable complexity */

/**
 * Resolve server TLS options from resolved config. Returns null when TLS is
 * not configured; throws when only one of cert/key is set (fail fast at
 * startup rather than serving plaintext when the operator expected TLS).
 */
export function resolveTlsServerOptions(config: {
  tlsCertFile?: string;
  tlsKeyFile?: string;
}): { certFile: string; keyFile: string } | null {
  const { tlsCertFile, tlsKeyFile } = config;
  if (!tlsCertFile && !tlsKeyFile) return null;
  if (!tlsKeyFile) {
    throw new Error(
      'TLS misconfigured: tlsCertFile is set but tlsKeyFile (TLS_KEY_FILE) is missing'
    );
  }
  if (!tlsCertFile) {
    throw new Error(
      'TLS misconfigured: tlsKeyFile is set but tlsCertFile (TLS_CERT_FILE) is missing'
    );
  }
  return { certFile: tlsCertFile, keyFile: tlsKeyFile };
}
