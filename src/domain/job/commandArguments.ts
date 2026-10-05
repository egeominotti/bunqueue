/**
 * Duration arguments of job commands: ChangeDelay/MoveToDelayed `delay`, lease lengths
 * (PULL/PULLB `lockTtl`, ExtendLock(s) and JobHeartbeat `duration`) and a pull's
 * long-poll `timeout`. The broker's TCP handlers, the QueueManager (embedded and
 * `bunqueue/queue`) and the PostgreSQL engine use these, so every caller gets the
 * same result as on 2.9.10 wherever 2.9.10's result was well defined
 * (docs/features/job-options-validation.md).
 */

import { clampDuration, coerceNumericString, FINITE, numberError } from './optionBounds';

/**
 * ChangeDelay/MoveToDelayed `delay`: required, finite (a numeric string is its number).
 * NaN never came due; any finite value has a meaning (see `delayArgument`).
 */
export function validateDelayArgument(value: unknown, name = 'delay'): string | null {
  return numberError(value, '', name, { ...FINITE, required: true });
}

export function assertDelayArgument(value: unknown, name = 'delay'): void {
  const error = validateDelayArgument(value, name);
  if (error) throw new Error(error);
}

/**
 * The delay a ChangeDelay/MoveToDelayed applies (`runAt = now + delay`), as on 2.9.10: a
 * negative delay (the `runAt - Date.now()` of a run time already past) is kept, so the
 * job is ready with a past run time and sorts ahead of later ready jobs; a delay beyond
 * the honoured range, either way, is clamped to ±MAX_JOB_DURATION_MS. Throws the
 * `validateDelayArgument` error for a missing, non-numeric or non-finite delay.
 */
export function delayArgument(value: unknown, name = 'delay'): number {
  assertDelayArgument(value, name);
  return clampDuration(coerceNumericString(value) as number);
}

/**
 * A lease length (PULL/PULLB `lockTtl`, ExtendLock(s) and JobHeartbeat `duration`):
 * any finite number of ms, passed through as 2.9.10 did. undefined/null mean "the
 * default TTL". A 2.9.10 Worker with `lockDuration: 0` sends `lockTtl: 0`; refusing it
 * made every pull fail, which that Worker reads as an empty queue. Only NaN, an
 * infinity or a non-number (a string included: `now + '5000'` is a string) is refused:
 * such a lease would never expire.
 */
export function validateLockDuration(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number') return `${name} must be a number`;
  return Number.isFinite(value) ? null : `${name} must be a finite number`;
}

export function assertLockDuration(value: unknown, name: string): void {
  const error = validateLockDuration(value, name);
  if (error) throw new Error(error);
}

/** The longest long-poll wait of a pull (`PULL`/`PULLB` `timeout`). */
const MAX_PULL_TIMEOUT_MS = 60_000;

/**
 * A PULL/PULLB long-poll `timeout` on the wire: finite, 0 to 60,000 ms (2.9.10's TCP
 * rule); undefined/null mean 0 (no wait).
 */
export function validatePullTimeout(value: unknown): string | null {
  return numberError(value, '', 'timeout', { min: 0, max: MAX_PULL_TIMEOUT_MS }, false);
}

export function assertPullTimeout(value: unknown): void {
  const error = validatePullTimeout(value);
  if (error) throw new Error(error);
}

/**
 * The wait of a direct `QueueManager.pull*` call, which 2.9.10 never refused nor capped:
 * a negative value, NaN or a non-number is no wait (as 2.9.10 treated it); any longer
 * wait, Infinity included (until a job arrives or the signal aborts), is honoured as on
 * 2.9.10 through the overflow-safe waiter timers. TCP/HTTP PULL keep the 60 s bound.
 */
export function pullTimeoutArgument(value: unknown): number {
  const timeout = coerceNumericString(value);
  return typeof timeout === 'number' && timeout > 0 ? timeout : 0;
}

/**
 * The broker's reply when ExtendLock finds no lease for the job and token. Clients map
 * it to "not extended" (0), as embedded mode and BullMQ do; any other rejection throws.
 */
export const LOCK_NOT_EXTENDED_ERROR = 'Lock not found or invalid token';
