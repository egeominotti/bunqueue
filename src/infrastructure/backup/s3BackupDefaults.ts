/**
 * S3 backup defaults and limits. A dependency-free leaf, so the configuration layer
 * (`src/config/settings.ts`) can read them while `s3BackupConfig.ts` imports the
 * configuration layer, without an import cycle.
 */

/** Default configuration values */
export const DEFAULTS = {
  intervalMs: 6 * 60 * 60 * 1000, // 6 hours
  retention: 7,
  prefix: 'backups/',
  region: 'us-east-1',
} as const;

/** Shortest accepted backup interval: one minute. */
export const MIN_BACKUP_INTERVAL_MS = 60_000;

/** Fewest backups retention may keep: pruning never deletes the newest backup. */
export const MIN_BACKUP_RETENTION = 1;
