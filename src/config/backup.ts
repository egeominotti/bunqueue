/**
 * S3 backup configuration: config file > env vars > defaults, validated. This is the
 * single source for the server (`resolveServerConfig` and `bootServer`) and the
 * `bunqueue backup` CLI (`S3BackupManager.fromEnv` / `resolveBackupCommandConfig`), so
 * they cannot read the same setting differently.
 *
 * A backup problem never stops the server, as in 2.9.10: an enabled backup that cannot
 * run (no bucket or credentials, an interval under a minute, an invalid retention)
 * carries the problems as `configErrors`, which the scheduler logs at error level
 * before running without backups; an invalid value of a disabled backup is a warning.
 * An invalid retention is never applied, so it can never prune. S3_BACKUP_INTERVAL and
 * S3_BACKUP_RETENTION keep their 2.9.10 fallback (`parseInt(...) || default`): 0 or a
 * value without a number means the default, with a warning. `bunqueue backup` refuses
 * an invalid interval or retention.
 */

import type { S3BackupConfig } from '../infrastructure/backup/s3BackupConfig';
import { DEFAULTS } from '../infrastructure/backup/s3BackupDefaults';
import { readEnvInteger } from '../shared/durations';
import { envSource, type NumericSetting } from './envSetting';
import { ConfigError, ConfigIssues, assertWhole, expectedText, type Env } from './numbers';
import { normalizeConfigSection } from './schema';
import { fileNumberString, fileValueError } from './schemaFields';
import { SETTINGS } from './settings';
import { selectStorage, type StorageSelection } from './storage';
import { envBoolean } from './text';
import type { BunqueueConfig } from './types';

type BackupSection = NonNullable<BunqueueConfig['backup']>;
export type BackupSettings = Omit<S3BackupConfig, 'databasePath' | 'configErrors'>;

/** The backup settings and what keeps them from running, each naming the setting. */
export interface BackupResolution {
  readonly settings: BackupSettings;
  /** Invalid values: the config-file keys (held by the schema), interval and retention. */
  readonly problems: readonly string[];
  /** Missing bucket or credentials (`validateConfig` reports them in the CLI). */
  readonly missing: readonly string[];
}

const REQUIRED: ReadonlyArray<[keyof BackupSettings, string]> = [
  ['bucket', 'bucket (backup.bucket, S3_BUCKET or AWS_BUCKET)'],
  ['accessKeyId', 'access key ID (backup.accessKeyId, S3_ACCESS_KEY_ID or AWS_ACCESS_KEY_ID)'],
  [
    'secretAccessKey',
    'secret access key (backup.secretAccessKey, S3_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY)',
  ],
];

/**
 * `backup.interval` / `backup.retention` (a number or a numeric string, rounded down),
 * else the env var with its 2.9.10 fallback. An invalid value is added to `problems`
 * and the default is returned in its place (the backup does not run with problems).
 */
function backupNumber(
  fileValue: unknown,
  setting: NumericSetting & { readonly file: string; readonly fallback: number },
  env: Env,
  issues: ConfigIssues,
  problems: string[]
): number {
  const { rule, fallback } = setting;
  const expected = expectedText(rule);
  if (fileValue !== undefined) {
    const value = typeof fileValue === 'string' ? fileNumberString(fileValue, rule) : fileValue;
    try {
      return assertWhole(value, setting.file, rule);
    } catch (error) {
      problems.push(fileValueError(error, fileValue));
      return fallback;
    }
  }
  const [name, raw] = envSource(setting, env);
  if (raw === undefined || raw === '') return fallback;
  const reading = readEnvInteger(raw, { unit: rule.unit });
  const value = reading.kind === 'number' ? reading.value : undefined;
  if (reading.kind === 'invalid' || value === 0) {
    issues.warn(
      `Invalid ${name}: ${JSON.stringify(raw)} (expected ${expected}); using ${fallback}`
    );
    return fallback;
  }
  if (value !== undefined && Number.isSafeInteger(value) && value >= rule.min) return value;
  problems.push(`Invalid ${name}: ${JSON.stringify(raw)} (expected ${expected})`);
  return fallback;
}

/**
 * Every backup setting except the database path. Warnings (an unknown boolean word, a
 * tolerated interval or retention) go to `issues`; the problems are returned for the
 * caller to report: they disable an enabled backup and are warnings otherwise.
 */
export function backupSettings(
  fc: BackupSection | undefined,
  env: Env,
  issues: ConfigIssues
): BackupResolution {
  const problems = issues.take('backup');
  const settings: BackupSettings = {
    enabled: fc?.enabled ?? envBoolean('S3_BACKUP_ENABLED', env, false, issues),
    accessKeyId: fc?.accessKeyId ?? env.S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey:
      fc?.secretAccessKey ?? env.S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY ?? '',
    sessionToken: fc?.sessionToken ?? env.S3_SESSION_TOKEN ?? env.AWS_SESSION_TOKEN,
    bucket: fc?.bucket ?? env.S3_BUCKET ?? env.AWS_BUCKET ?? '',
    endpoint: fc?.endpoint ?? env.S3_ENDPOINT ?? env.AWS_ENDPOINT,
    // 2.9.10 compared "1" / "true": any other word meant false (path-style requests).
    virtualHostedStyle:
      fc?.virtualHostedStyle ??
      envBoolean('S3_VIRTUAL_HOSTED_STYLE', env, undefined, issues, false),
    region: fc?.region ?? env.S3_REGION ?? env.AWS_REGION ?? DEFAULTS.region,
    intervalMs: backupNumber(fc?.interval, SETTINGS.backupIntervalMs, env, issues, problems),
    retention: backupNumber(fc?.retention, SETTINGS.backupRetention, env, issues, problems),
    prefix: fc?.prefix ?? env.S3_BACKUP_PREFIX ?? DEFAULTS.prefix,
  };
  const absent = REQUIRED.filter(([key]) => !settings[key]).map(([, label]) => label);
  const missing =
    absent.length === 0 ? [] : [`S3 backup required settings are missing: ${absent.join(', ')}`];
  return { settings, problems, missing };
}

/**
 * Resolve the S3 backup config for the server (and `S3BackupManager.fromEnv`). Never
 * throws for a backup problem: the config carries `configErrors` (see the module
 * comment) — an invalid value always, missing credentials when the backup is enabled —
 * so neither the scheduler nor a manual `backup()` runs with a placeholder interval or
 * retention. Throws a `ConfigError` only for an unusable `backup.enabled`.
 */
export function resolveBackupConfig(
  fileConfig: BunqueueConfig | null,
  databasePath: string,
  env: Env = Bun.env
): S3BackupConfig {
  const issues = new ConfigIssues();
  const fc = normalizeConfigSection(fileConfig, 'backup', issues);
  const { settings, problems, missing } = backupSettings(fc, env, issues);
  issues.throwIfAny();
  const configErrors = [...problems, ...(settings.enabled ? missing : [])];
  return { ...settings, databasePath, ...(configErrors.length > 0 && { configErrors }) };
}

/**
 * What `bunqueue backup` operates on: the server's own storage selection and backup
 * settings, from the same config file (`--config`, else the discovered one) with the
 * same precedence (file > env > defaults). An invalid interval or retention throws a
 * `ConfigError` naming it; missing credentials are reported by the command.
 */
export function resolveBackupCommandConfig(
  fileConfig: BunqueueConfig | null,
  env: Env = Bun.env
): { selection: StorageSelection; settings: BackupSettings } {
  const issues = new ConfigIssues();
  const storage = normalizeConfigSection(fileConfig, 'storage', issues);
  const backup = normalizeConfigSection(fileConfig, 'backup', issues);
  const selection = selectStorage(storage, env, issues);
  const { settings, problems } = backupSettings(backup, env, issues);
  issues.throwIfAny();
  if (problems.length > 0) throw new ConfigError([...problems]);
  return { selection, settings };
}
