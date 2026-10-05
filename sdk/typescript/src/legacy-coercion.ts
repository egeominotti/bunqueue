/**
 * 0.2.2 compatibility for the legacy entry's option values.
 *
 * 0.2.2 passed option values straight to JavaScript arithmetic, comparisons and
 * `setTimeout`, so a numeric string worked as its number, and a negative or `NaN`
 * one-shot delay ran on the next timer tick. 0.2.3 validates options where they enter,
 * but must keep every result 0.2.2 produced without a hot loop, a hang, an immediate
 * timeout or a crash. These helpers restore those results; the values 0.2.2 really
 * broke (a delay beyond the timer limit, `Infinity` where it is not "never") still
 * throw. See LEGACY.md, "Option validation".
 */

import { describeValue } from './timing.js';

/**
 * A string whose `Number()` is a number (`'5000'`, `' 1e3 '`, `''`) is read as that
 * number, as 0.2.2's arithmetic and timers read it. Any other value is returned
 * unchanged for the caller to validate.
 */
export function numericString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const number = Number(value);
  return Number.isNaN(number) ? value : number;
}

/**
 * A one-shot delay that 0.2.2 handed to `setTimeout` (a flush delay, a retry or reset
 * wait, a cancel grace period): a numeric string is its number, and `NaN` or a negative
 * delay is 0, which is when `setTimeout` ran it. A finite delay is honoured at any
 * length. `Infinity` is accepted only with `allowInfinity` (it then arms nothing);
 * otherwise it throws a RangeError, because 0.2.2 fired it after about 1 ms instead of
 * never. A value that is neither a number nor a numeric string throws a TypeError.
 */
export function legacyDelay(value: unknown, name: string, allowInfinity = false): number {
  const delay = numericString(value);
  if (typeof delay !== 'number') {
    throw new TypeError(`${name} must be a number of milliseconds (got ${describeValue(value)})`);
  }
  if (delay !== delay || delay <= 0) return 0;
  if (delay === Infinity && !allowInfinity) {
    throw new RangeError(`${name} must be a finite number of milliseconds (got Infinity)`);
  }
  return delay;
}
