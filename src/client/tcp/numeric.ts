/**
 * Client option numbers read the way 2.9.10 read them.
 *
 * 2.9.10 used raw option values in comparisons, loop bounds and native timers, all of
 * which coerce a numeric string: `connection: { port: process.env.PORT }` connected,
 * and `concurrency: '4'` ran 4 jobs. The options are validated now, so that coercion is
 * explicit and limited to plain decimal digits (surrounding whitespace allowed). Any
 * other string (`'6789.5'`, `'1e3'`, `'abc'`, `'-1'`) stays a string, which validation
 * rejects with a TypeError naming the option. Used by the TCP connection options, the
 * Worker, SandboxedWorker, Simple Mode (Bunqueue) and Queue `autoBatch` options.
 */

const DECIMAL_DIGITS = /^\s*\d+\s*$/;

/** `value` as a number when it is a string of decimal digits, otherwise unchanged. */
export function coerceNumericString(value: unknown): unknown {
  return typeof value === 'string' && DECIMAL_DIGITS.test(value) ? Number(value) : value;
}

/** True for a number that is neither NaN nor infinite. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * A finite count rounded up, never below `min`. 2.9.10 compared counts with `>=` and
 * `<` (`active >= concurrency`, `failures >= threshold`, `i < poolSize`), so a fraction
 * acted as the next whole number and a value below `min` as `min`.
 */
export function ceilAtLeast(value: number, min: number): number {
  return Math.max(min, Math.ceil(value));
}
