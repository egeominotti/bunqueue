/**
 * The clamps every official SDK applies at its surface (sdk/CLAUDE.md rule 4 and
 * docs/protocol.md sections 6.3 and 9). The legacy entry is the 0.1.x compatibility
 * surface, so for these four options the SDK rule wins over the main client's stricter
 * validation (documented in LEGACY.md, "Option validation"):
 *
 * - a heartbeat interval of 0, a negative or a non-finite value disables heartbeats;
 * - `batchSize`, the poll timeout and the `waitForJob` ttl are clamped to what the
 *   broker accepts, and a non-finite value takes the default (the "finite guard" of the
 *   0.1.x batchSize: NaN passes both bounds of a Math.min/Math.max clamp).
 *
 * A number never throws here, and every result 0.2.2 produced is kept: a non-number
 * heartbeat interval disables heartbeats and a non-number batchSize means 10 (0.2.2's
 * finite guards), a numeric string poll timeout or ttl is its number (0.2.2's
 * Math.min/Math.max read it so), and a `null` ttl is a zero hold. Only a poll timeout or
 * ttl that is neither a number nor a numeric string throws a TypeError naming the
 * option: 0.2.2 sent it as NaN and failed every pull or wait.
 */

import { numericString } from './legacy-coercion.js';
import { describeValue } from './timing.js';
import { MAX_POLL_TIMEOUT_MS } from './worker-types.js';

/** The broker rejects a PULLB count above 1000. */
const MAX_BATCH_SIZE = 1000;
/** The broker holds a WaitJob for at most 600000 ms. */
const MAX_WAIT_JOB_MS = 600_000;

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_POLL_TIMEOUT_MS = 5000;
const DEFAULT_WAIT_JOB_MS = 30_000;

/**
 * Heartbeat interval in seconds: a finite number > 0, else 0 (disabled), as 0.2.2's
 * finite guard: 0, negative, non-finite and non-number values disable heartbeats.
 */
export function heartbeatSeconds(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** PULLB batch size: clamped to [1, 1000]; a non-finite or non-number value means 10. */
export function clampBatchSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_BATCH_SIZE;
  return Math.min(Math.max(1, value), MAX_BATCH_SIZE);
}

/**
 * PULLB long-poll timeout: clamped to [0, 30000]; NaN means the default (5000). A
 * numeric string is its number; `name` is the option as the caller spells it.
 */
export function clampPollTimeout(value: unknown, name = 'Worker: pollTimeoutMs'): number {
  const timeout = requireNumber(numericString(value), name, 'a number', value);
  if (Number.isNaN(timeout)) return DEFAULT_POLL_TIMEOUT_MS;
  return Math.min(Math.max(0, timeout), MAX_POLL_TIMEOUT_MS);
}

/**
 * The single WaitJob hold of `waitForJob`: omitted or NaN means 30000; `null` is a zero
 * hold (0.2.2 clamped it to 0: the broker answers at once); a numeric string is its
 * number; anything else is clamped to the broker's [0, 600000] (Infinity holds for the
 * maximum).
 */
export function waitJobTtl(ttlMs: number | null | undefined): number {
  if (ttlMs === undefined) return DEFAULT_WAIT_JOB_MS;
  if (ttlMs === null) return 0;
  const name = 'Queue: waitForJob() ttlMs';
  const ttl = requireNumber(numericString(ttlMs), name, 'a number of milliseconds', ttlMs);
  if (Number.isNaN(ttl)) return DEFAULT_WAIT_JOB_MS;
  return Math.min(Math.max(ttl, 0), MAX_WAIT_JOB_MS);
}

/**
 * Throw a TypeError naming the option unless `value` is a number (NaN included);
 * `shown` is the value as the caller passed it, before any coercion.
 */
export function requireNumber(
  value: unknown,
  name: string,
  expected: string,
  shown: unknown = value
): number {
  if (typeof value === 'number') return value;
  throw new TypeError(`${name} must be ${expected} (got ${describeValue(shown)})`);
}
