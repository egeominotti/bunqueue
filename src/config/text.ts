/**
 * Text server settings: booleans and log words.
 *
 * Booleans used to be compared with one spelling: `S3_BACKUP_ENABLED=yes` meant false
 * and `BUNQUEUE_CLOUD_REMOTE_COMMANDS=0` meant true. Every boolean env var now honours
 * the same words, in any case and after trimming: 1/0, true/false, yes/no, on/off. An
 * empty value is unset. Any other word keeps the value 2.9.10 gave it (its own one
 * spelling: usually the default) and is reported as a warning, never a startup error.
 *
 * Log words (LOG_LEVEL, LOG_FORMAT, `logging.level`, `logging.format`) are matched in
 * any case, after trimming and removing surrounding quotes; common aliases map to a level
 * (`warning` -> warn, `trace` / `verbose` -> debug, `fatal` / `critical` -> error). An
 * unknown word is a warning: 2.9.10 ignored it.
 */

import type { ConfigIssues, Env } from './numbers';

const TRUE_WORDS = ['1', 'true', 'yes', 'on'] as const;
const FALSE_WORDS = ['0', 'false', 'no', 'off'] as const;
const BOOLEAN_WORDS = ['1', '0', 'true', 'false', 'yes', 'no', 'on', 'off'] as const;

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevelWord = (typeof LOG_LEVELS)[number];
export const LOG_FORMATS = ['text', 'json'] as const;
export type LogFormat = (typeof LOG_FORMATS)[number];

// A Map, not an object literal: `constructor` or `__proto__` must not name a level.
const LEVEL_ALIASES: ReadonlyMap<string, LogLevelWord> = new Map([
  ['debug', 'debug'],
  ['trace', 'debug'],
  ['verbose', 'debug'],
  ['info', 'info'],
  ['warn', 'warn'],
  ['warning', 'warn'],
  ['error', 'error'],
  ['fatal', 'error'],
  ['critical', 'error'],
]);

/** `raw` trimmed, lowercased and without one pair of surrounding quotes. */
function word(raw: string): string {
  const trimmed = raw.trim();
  const unquoted = /^(["'])(.*)\1$/.exec(trimmed)?.[2] ?? trimmed;
  return unquoted.trim().toLowerCase();
}

/** The boolean an env word spells, or undefined when it is none of the accepted words. */
export function booleanWord(raw: string): boolean | undefined {
  const value = raw.trim().toLowerCase();
  if ((TRUE_WORDS as readonly string[]).includes(value)) return true;
  if ((FALSE_WORDS as readonly string[]).includes(value)) return false;
  return undefined;
}

/** The log level a word names (aliases included), or undefined. */
export function logLevelWord(raw: unknown): LogLevelWord | undefined {
  return typeof raw === 'string' ? LEVEL_ALIASES.get(word(raw)) : undefined;
}

/** The log format a word names, or undefined. */
export function logFormatWord(raw: unknown): LogFormat | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = word(raw);
  return (LOG_FORMATS as readonly string[]).includes(value) ? (value as LogFormat) : undefined;
}

/**
 * A boolean env var. `undefined` or `''` returns `fallback` (which may be `undefined`
 * for "not set"). An unknown word returns `unknown` (what 2.9.10 made of it; default
 * `fallback`) and records a warning in `issues`.
 */
export function envBoolean<F extends boolean | undefined>(
  name: string,
  env: Env,
  fallback: F,
  issues: ConfigIssues,
  unknown: boolean | F = fallback
): boolean | F {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = booleanWord(raw);
  if (value !== undefined) return value;
  issues.warn(
    `Invalid ${name}: ${JSON.stringify(raw)} (expected one of ${BOOLEAN_WORDS.join(', ')}); using ${String(unknown)}`
  );
  return unknown;
}
