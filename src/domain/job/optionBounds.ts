/**
 * Numeric rules shared by job options and job command arguments.
 *
 * Bounds keep only what guards real breakage, so every value 2.9.10 ran with a
 * well-defined result is still admitted (see docs/features/job-options-validation.md):
 * - a value that is not a number, NaN or an infinity is refused (it never comes due,
 *   never expires, or breaks the heap order or a NOT NULL column);
 * - a duration is honoured up to `MAX_JOB_DURATION_MS`; a longer one is clamped to it
 *   (both mean "never" in practice), so `timestamp + duration` stays a valid date;
 * - a plain decimal numeric string (`'3'`, `' -2.5 '`) is read as its number, as 2.9.10
 *   used it (it also fixes `delay: '1000'`, which string arithmetic turned into a date
 *   thousands of years away).
 */

/** The latest instant a JavaScript Date can represent: 8.64e15 ms after the epoch. */
export const MAX_DATE_MS = 8_640_000_000_000_000;
/**
 * The longest honoured job duration (`delay`, `ttl`, `timeout`, `dedup.ttl`,
 * `debounceTtl`, `repeat.every`, ChangeDelay): half the Date range, about 136,900
 * years. A longer finite value is clamped to it.
 */
export const MAX_JOB_DURATION_MS = MAX_DATE_MS / 2;
/** `maxAttempts` (`attempts`): PostgreSQL stores it as INTEGER; a larger value is clamped. */
export const MAX_JOB_ATTEMPTS = 2_147_483_647;

const NUMERIC_STRING = /^\s*[+-]?\d+(\.\d+)?\s*$/;

/** A plain decimal numeric string as its number; any other value unchanged. */
export function coerceNumericString(value: unknown): unknown {
  return typeof value === 'string' && NUMERIC_STRING.test(value) ? Number(value) : value;
}

/** Inclusive bounds of one numeric field. */
export interface Bounds {
  readonly min: number;
  readonly max: number;
  readonly integer?: boolean;
  readonly required?: boolean;
  /** A finite value above `max` is accepted: normalization clamps it to `max`. */
  readonly clamp?: boolean;
}

/** Any finite number. */
export const FINITE: Bounds = { min: Number.NEGATIVE_INFINITY, max: Number.POSITIVE_INFINITY };

/**
 * The first violation of `bounds` by `value`, named `${prefix}${name}`, or null.
 * null/undefined mean "not set" unless required. With `coerce` (job options and delay
 * arguments, whose engines normalize the value), a numeric string counts as its number;
 * without it (command fields passed on as they are), a string is not a number.
 */
export function numberError(
  value: unknown,
  prefix: string,
  name: string,
  bounds: Bounds,
  coerce = true
): string | null {
  if (value === undefined || value === null) {
    return bounds.required === true ? `${prefix}${name} is required` : null;
  }
  const number = coerce ? coerceNumericString(value) : value;
  if (typeof number !== 'number') return `${prefix}${name} must be a number`;
  if (!Number.isFinite(number)) return `${prefix}${name} must be a finite number`;
  if (bounds.integer === true && !Number.isInteger(number)) {
    return `${prefix}${name} must be an integer`;
  }
  if (number < bounds.min) return `${prefix}${name} must be at least ${bounds.min}`;
  if (bounds.clamp !== true && number > bounds.max) {
    return `${prefix}${name} must be at most ${bounds.max}`;
  }
  return null;
}

/**
 * A duration clamped to the honoured range, ±MAX_JOB_DURATION_MS (a negative delay is a
 * run time in the past; the bound keeps `timestamp + delay` a valid date). NaN and
 * non-numbers pass through.
 */
export function clampDuration(value: number): number {
  if (value > MAX_JOB_DURATION_MS) return MAX_JOB_DURATION_MS;
  return value < -MAX_JOB_DURATION_MS ? -MAX_JOB_DURATION_MS : value;
}

/**
 * The attempt count createJob stores for `maxAttempts`, with 2.9.10's behavior:
 * 0 (BullMQ's default) and below run once, as 1 does; a fraction rounds up (2.5 made
 * 2.9.10 run 3 attempts); Infinity and anything above the INTEGER range are the maximum
 * ("retry forever"). The stored value therefore always bounds the attempts made.
 */
export function attemptCount(value: number): number {
  if (value !== value) return value;
  if (value <= 1) return 1;
  return value >= MAX_JOB_ATTEMPTS ? MAX_JOB_ATTEMPTS : Math.ceil(value);
}

/**
 * `attempts`: any number, ±Infinity included (`attemptCount` stores 1 for 1 or less, as
 * 2.9.10 ran such a job exactly once); NaN and non-numbers are refused.
 */
export function attemptsError(value: unknown, prefix: string, name: string): string | null {
  if (value === undefined || value === null) return null;
  const number = coerceNumericString(value);
  return typeof number === 'number' && number === number
    ? null
    : `${prefix}${name} must be a number`;
}
