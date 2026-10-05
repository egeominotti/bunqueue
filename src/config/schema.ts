/**
 * Config-file validation. `defineConfig` returns its argument and `loadConfigFile`
 * returns whatever the module exports, so every value is checked here, against the
 * shapes in `types.ts`, before the server reads it. The rules keep what 2.9.10 did with
 * a value (see `schemaFields.ts`):
 *
 * - a section or key set to `null` is absent;
 * - a value 2.9.10 used is accepted (numeric strings for ports and timeouts, the
 *   truthiness of a non-boolean boolean key, with a warning, a comma-separated
 *   `cors.origins`); a value it replaced with a fallback
 *   keeps that fallback with a warning; a value it could not use is an error naming
 *   the key (`timeouts.stats must be ...`);
 * - `timeouts.worker`, `timeouts.lock` and `webhooks.*` are ignored, as they always
 *   were, with a warning naming the env var to use instead;
 * - `logging.level` / `logging.format` pass through: `resolve.ts` reads them with the
 *   log words of `text.ts` (aliases, any case), and an unknown word is a warning;
 * - the errors of a PostgreSQL or S3 backup key are held for that feature
 *   (`ConfigIssues.forFeature`): they stop startup only when the feature is in use;
 * - an unknown key is a warning, not an error (forward compatibility).
 *
 * The result is a normalized copy: invalid values are dropped (the caller throws
 * before using it) and fractional numbers are rounded down.
 */

import { describeValue as describe } from '../shared/durations';
import type { NumericSetting } from './envSetting';
import type { ConfigIssues } from './numbers';
import {
  INVALID,
  UNSET,
  checkBoolean,
  checkEnum,
  checkNumber,
  checkOrigins,
  checkRetention,
  checkString,
  checkTokens,
  type Checked,
} from './schemaFields';
import { SETTINGS } from './settings';
import type { BunqueueConfig } from './types';

type Field =
  | { readonly kind: 'string' | 'boolean' | 'origins' | 'tokens' | 'raw' | 'retention' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'ignored'; readonly env: string }
  | { readonly kind: 'number'; readonly setting: NumericSetting };

const STRING: Field = { kind: 'string' };
const BOOLEAN: Field = { kind: 'boolean' };
const RAW: Field = { kind: 'raw' };
const ignored = (env: string): Field => ({ kind: 'ignored', env });

/** Every non-numeric key of the file schema; numeric keys come from `SETTINGS`. */
const OTHER_FIELDS: Record<string, Record<string, Field>> = {
  server: {
    host: STRING,
    tcpSocketPath: STRING,
    httpSocketPath: STRING,
    tlsCertFile: STRING,
    tlsKeyFile: STRING,
  },
  auth: { tokens: { kind: 'tokens' }, requireAuthForMetrics: BOOLEAN },
  storage: {
    driver: { kind: 'enum', values: ['memory', 'sqlite', 'postgres'] },
    dataPath: STRING,
    url: STRING,
    namespace: STRING,
    brokerId: STRING,
    completedRetentionMs: { kind: 'retention' },
  },
  telemetry: {},
  cors: { origins: { kind: 'origins' } },
  cloud: { url: STRING, apiKey: STRING, instanceId: STRING },
  backup: {
    enabled: BOOLEAN,
    bucket: STRING,
    accessKeyId: STRING,
    secretAccessKey: STRING,
    sessionToken: STRING,
    region: STRING,
    endpoint: STRING,
    virtualHostedStyle: BOOLEAN,
    prefix: STRING,
    // validated by `backup.ts`: an invalid value disables the backup, never startup
    interval: RAW,
    retention: RAW,
  },
  timeouts: { worker: ignored('WORKER_TIMEOUT_MS'), lock: ignored('LOCK_TIMEOUT_MS') },
  webhooks: {
    maxRetries: ignored('WEBHOOK_MAX_RETRIES'),
    retryDelay: ignored('WEBHOOK_RETRY_DELAY_MS'),
  },
  logging: { level: RAW, format: RAW },
};

const SCHEMA: Record<string, Record<string, Field>> = (() => {
  const schema: Record<string, Record<string, Field>> = {};
  for (const [section, fields] of Object.entries(OTHER_FIELDS)) schema[section] = { ...fields };
  for (const setting of Object.values(SETTINGS) as NumericSetting[]) {
    if (setting.file === undefined) continue;
    const [section, key] = setting.file.split('.');
    schema[section][key] ??= { kind: 'number', setting };
  }
  return schema;
})();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkField(field: Field, value: unknown, path: string, issues: ConfigIssues): Checked {
  switch (field.kind) {
    case 'string':
      return checkString(value, path, issues);
    case 'boolean':
      return checkBoolean(value, path, issues);
    case 'origins':
      return checkOrigins(value, path, issues);
    case 'tokens':
      return checkTokens(value, path, issues);
    case 'enum':
      return checkEnum(value, field.values, path, issues);
    case 'raw':
      return value;
    case 'retention':
      return checkRetention(value, path, issues);
    case 'ignored':
      issues.warn(
        `Config key "${path}" is ignored (it never took effect); set ${field.env} instead`
      );
      return UNSET;
    case 'number':
      return checkNumber(value, path, field.setting, issues);
  }
}

function checkSection(
  section: string,
  value: unknown,
  issues: ConfigIssues,
  warnUnknown: boolean
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    issues.error(`${section} must be an object (got ${describe(value)})`);
    return undefined;
  }
  const fields = SCHEMA[section];
  const normalized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const field = fields[key];
    if (field === undefined) {
      if (warnUnknown) issues.warn(`Unknown config key "${section}.${key}" is ignored`);
      continue;
    }
    // null is unset, except for the retention, where it means "off"
    if (item === undefined || (item === null && field.kind !== 'retention')) continue;
    // A backup key never stops startup: its errors are held for the backup (`backup.ts`).
    const target = section === 'backup' && key !== 'enabled' ? issues.forFeature('backup') : issues;
    const checked = checkField(field, item, `${section}.${key}`, target);
    if (checked !== INVALID && checked !== UNSET) normalized[key] = checked;
  }
  return normalized;
}

/**
 * Validate a whole config file. Errors and warnings go to `issues` (backup and
 * PostgreSQL errors held for their feature); the return value holds only the valid
 * keys, normalized.
 */
export function normalizeConfigFile(raw: unknown, issues: ConfigIssues): BunqueueConfig | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) {
    issues.error(`The config file must export an object (got ${describe(raw)})`);
    return null;
  }
  const normalized: Record<string, unknown> = {};
  for (const [section, value] of Object.entries(raw)) {
    if (SCHEMA[section] === undefined) {
      issues.warn(`Unknown config key "${section}" is ignored`);
      continue;
    }
    const checked = checkSection(section, value, issues, true);
    if (checked !== undefined) normalized[section] = checked;
  }
  return normalized as BunqueueConfig;
}

/** Validate one section of a config file (the whole-file pass reports unknown keys). */
export function normalizeConfigSection<K extends keyof BunqueueConfig>(
  raw: BunqueueConfig | null | undefined,
  section: K,
  issues: ConfigIssues
): BunqueueConfig[K] | undefined {
  if (!isRecord(raw)) return undefined;
  return checkSection(section, raw[section], issues, false) as BunqueueConfig[K] | undefined;
}
