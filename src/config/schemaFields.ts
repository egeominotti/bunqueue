/**
 * Checks for one config-file value, by kind. Each returns the normalized value, `UNSET`
 * (the key is treated as absent: `null`, or a value 2.9.10 ignored) or `INVALID` (an
 * error was recorded). The rules follow what 2.9.10 did with the same value:
 *
 * - `null` means unset (`host: null`, `bucket: process.env.S3_BUCKET ?? null`);
 * - a numeric string works where 2.9.10 coerced it (ports, timeouts, backup);
 * - a count 2.9.10 wrapped in a fallback (`positiveInteger`) keeps that fallback, with a
 *   warning, for NaN, a string or a value below the minimum;
 * - a boolean given as another type keeps 2.9.10's truthiness (`'false'` is true),
 *   with a warning;
 * - `cors.origins` accepts a comma-separated string, and drops empty entries;
 * - `auth.tokens` entries must be non-empty strings (trimmed).
 */

import { describeValue as describe, readEnvInteger } from '../shared/durations';
import { isBlankToken } from './auth';
import type { NumericSetting } from './envSetting';
import { assertWhole, type ConfigIssues, type WholeRule } from './numbers';

export const INVALID = Symbol('invalid');
export const UNSET = Symbol('unset');
export type Checked = unknown;

/** Record `message` and return `INVALID`. */
export function fail(issues: ConfigIssues, message: string): typeof INVALID {
  issues.error(message);
  return INVALID;
}

export function checkString(value: unknown, path: string, issues: ConfigIssues): Checked {
  if (typeof value === 'string') return value;
  return fail(issues, `${path} must be a string (got ${describe(value)})`);
}

/**
 * A boolean. Any other value is read by its JavaScript truthiness, as 2.9.10 did
 * (`fc?.enabled ?? env`): `'false'` and `'0'` are true, `''` and `0` false. Reading
 * `'false'` as false would turn backups off or make /prometheus public on upgrade, so
 * the value keeps its 2.9.10 meaning and a warning asks for a real boolean.
 */
export function checkBoolean(value: unknown, path: string, issues: ConfigIssues): Checked {
  if (typeof value === 'boolean') return value;
  const truthy = Boolean(value);
  issues.warn(
    `${path} must be a boolean (got ${describe(value)}); read as ${String(truthy)}, as earlier releases did: use true or false`
  );
  return truthy;
}

/** An array of origins or a comma-separated string; empty entries are dropped. */
export function checkOrigins(value: unknown, path: string, issues: ConfigIssues): Checked {
  if (typeof value === 'string') return value.split(',').filter(Boolean);
  if (!Array.isArray(value)) {
    return fail(issues, `${path} must be an array of strings (got ${describe(value)})`);
  }
  const origins: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item === 'string' && item !== '') origins.push(item);
    else if (item === undefined || item === null || item === '') {
      issues.warn(`${path}[${index}] is empty (got ${describe(item)}); ignored`);
    } else {
      return fail(issues, `${path}[${index}] must be a string (got ${describe(item)})`);
    }
  }
  return origins;
}

/** An array of non-empty tokens, trimmed; each bad entry is named. */
export function checkTokens(value: unknown, path: string, issues: ConfigIssues): Checked {
  if (!Array.isArray(value)) {
    return fail(issues, `${path} must be an array of strings (got ${describe(value)})`);
  }
  let valid = true;
  for (const [index, token] of value.entries()) {
    if (typeof token !== 'string') {
      issues.error(`${path}[${index}] must be a non-empty string (got ${describe(token)})`);
      valid = false;
    } else if (isBlankToken(token)) {
      issues.error(
        `${path}[${index}] must not be empty or whitespace-only (got ${describe(token)})`
      );
      valid = false;
    }
  }
  return valid ? value.map((token: string) => token.trim()) : INVALID;
}

export function checkEnum(
  value: unknown,
  values: readonly string[],
  path: string,
  issues: ConfigIssues
): Checked {
  if (typeof value === 'string' && values.includes(value)) return value;
  const expected = values.map((item) => JSON.stringify(item)).join(', ');
  return fail(issues, `${path} must be one of ${expected} (got ${describe(value)})`);
}

/**
 * The message of an `assertWhole` error, naming what the file holds rather than the
 * number a string was read as (`(got "")`, not `(got NaN)`).
 */
export function fileValueError(error: unknown, value: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return typeof value === 'string'
    ? message.replace(/\(got [^)]*\)$/, `(got ${describe(value)})`)
    : message;
}

/** A numeric string as 2.9.10 coerced it: the env grammar, else `Number()`; '' is NaN. */
export function fileNumberString(raw: string, rule: WholeRule): number {
  const reading = readEnvInteger(raw, { unit: rule.unit });
  if (reading.kind === 'number') return reading.value;
  const text = raw.trim();
  return text === '' ? Number.NaN : Number(text);
}

/**
 * A numeric key: a finite number within the rule (rounded down), or a numeric string
 * where the setting allows one. Otherwise the setting's 2.9.10 fallback with a warning
 * (`legacy.invalid`, not for a value above the maximum), else an error, recorded in
 * the setting's feature bucket when it has one (see `ConfigIssues.forFeature`).
 */
export function checkNumber(
  value: unknown,
  path: string,
  setting: NumericSetting,
  issues: ConfigIssues
): Checked {
  const number =
    typeof value === 'string' && setting.fileStrings === true
      ? fileNumberString(value, setting.rule)
      : value;
  try {
    return assertWhole(number, path, setting.rule);
  } catch (error) {
    const message = fileValueError(error, value);
    const aboveMax =
      typeof number === 'number' &&
      Number.isFinite(number) &&
      number > (setting.rule.max ?? Infinity);
    const fallback = setting.legacy?.invalid;
    if (fallback !== undefined && !aboveMax) {
      issues.warn(`${message}; using ${fallback}`);
      return fallback;
    }
    const target = setting.feature === undefined ? issues : issues.forFeature(setting.feature);
    return fail(target, message);
  }
}

/**
 * `storage.completedRetentionMs`: whole milliseconds >= 0 (rounded down) or null (off).
 * 2.9.10 turned NaN, a negative, an infinite or unsafe number and a string into "no
 * retention"; that stays, with a warning.
 */
export function checkRetention(value: unknown, path: string, issues: ConfigIssues): Checked {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    const whole = Math.floor(value);
    if (Number.isSafeInteger(whole)) return whole;
  }
  issues.warn(
    `${path} must be a whole number of milliseconds >= 0 or null (got ${describe(value)}); completed-job retention is off`
  );
  return null;
}
