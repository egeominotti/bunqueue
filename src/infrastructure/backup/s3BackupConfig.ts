/**
 * S3 Backup Configuration
 * Types, defaults and validation. Env and config-file parsing lives in
 * `src/config/backup.ts`, the single source shared by the server and the CLI.
 */

import { resolveBackupConfig } from '../../config/backup';
import { MIN_BACKUP_INTERVAL_MS, MIN_BACKUP_RETENTION } from './s3BackupDefaults';

export { DEFAULTS, MIN_BACKUP_INTERVAL_MS, MIN_BACKUP_RETENTION } from './s3BackupDefaults';

/** S3 Backup configuration */
export interface S3BackupConfig {
  /** Enable S3 backup */
  enabled: boolean;
  /** S3 access key ID */
  accessKeyId: string;
  /** S3 secret access key */
  secretAccessKey: string;
  /** Temporary credential session token */
  sessionToken?: string;
  /** S3 bucket name */
  bucket: string;
  /** S3 endpoint (optional, for non-AWS S3-compatible services) */
  endpoint?: string;
  /** Use bucket-name-in-host S3 requests */
  virtualHostedStyle?: boolean;
  /** S3 region (optional, default: us-east-1) */
  region?: string;
  /** Backup interval in milliseconds (default: 6 hours) */
  intervalMs: number;
  /** Number of backups to retain (default: 7) */
  retention: number;
  /** Prefix for backup files (default: 'backups/') */
  prefix: string;
  /** Path to the SQLite database file */
  databasePath: string;
  /** Timeout for S3 operations in milliseconds (default: 30000) */
  timeoutMs?: number;
  /**
   * Why the configured backup cannot run, each naming the setting (no bucket, an
   * interval under a minute, an invalid retention). Set by the server configuration;
   * the scheduler logs them and does not start, as `validateConfig` reports them.
   */
  configErrors?: readonly string[];
}

/** Backup result */
export interface BackupResult {
  success: boolean;
  key?: string;
  /** Uncompressed SQLite database size in bytes */
  size?: number;
  /** Uploaded gzip object size in bytes */
  compressedSize?: number;
  duration?: number;
  error?: string;
}

/** Backup metadata stored in S3 */
export interface BackupMetadata {
  timestamp: string;
  version: string;
  /** Original uncompressed size in bytes */
  size: number;
  /** Compressed size in bytes (if compressed) */
  compressedSize?: number;
  checksum: string;
  /** Whether the backup is gzip compressed */
  compressed?: boolean;
}

/** Backup list item */
export interface BackupItem {
  key: string;
  size: number;
  lastModified: Date;
}

/**
 * Create configuration from environment variables. Delegates to the validated
 * resolver (`src/config/backup.ts`): an invalid value is carried in `configErrors`
 * (naming the variable), which `validateConfig` reports and the manager refuses to run.
 */
export function configFromEnv(databasePath: string): S3BackupConfig {
  return resolveBackupConfig(null, databasePath);
}

/**
 * True when `retention` is a whole number of backups >= 1. The prune refuses to
 * delete anything otherwise: `backups.slice(NaN)` is `slice(0)`, which would delete
 * every backup, the one just uploaded included.
 */
export function isValidRetention(retention: unknown): retention is number {
  return Number.isSafeInteger(retention) && (retention as number) >= MIN_BACKUP_RETENTION;
}

/** True when `intervalMs` is a whole number of milliseconds >= one minute. */
function isValidInterval(intervalMs: unknown): intervalMs is number {
  return Number.isSafeInteger(intervalMs) && (intervalMs as number) >= MIN_BACKUP_INTERVAL_MS;
}

/**
 * Validate configuration
 */
export function validateConfig(config: S3BackupConfig): { valid: boolean; errors: string[] } {
  // The server configuration already named every problem with its setting (file key or
  // env var), the missing credentials included; the checks below would only repeat them.
  if (config.configErrors !== undefined && config.configErrors.length > 0) {
    return { valid: false, errors: [...config.configErrors] };
  }
  const errors: string[] = [];

  if (!config.accessKeyId) {
    errors.push('S3_ACCESS_KEY_ID is required');
  }
  if (!config.secretAccessKey) {
    errors.push('S3_SECRET_ACCESS_KEY is required');
  }
  if (!config.bucket) {
    errors.push('S3_BUCKET is required');
  }
  if (!config.databasePath) {
    errors.push('Database path is required');
  }

  if (!isValidRetention(config.retention)) {
    errors.push(`Retention must be a whole number of backups >= 1 (got ${config.retention})`);
  }
  if (!isValidInterval(config.intervalMs)) {
    errors.push(
      `Backup interval must be a whole number of milliseconds >= 60000 (got ${config.intervalMs})`
    );
  }
  if (
    config.timeoutMs !== undefined &&
    !(Number.isSafeInteger(config.timeoutMs) && config.timeoutMs > 0)
  ) {
    errors.push(
      `S3 operation timeout must be a positive whole number of milliseconds (got ${config.timeoutMs})`
    );
  }

  return { valid: errors.length === 0, errors };
}
