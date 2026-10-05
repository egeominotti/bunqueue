/**
 * The stored form of validated job options, shared by every engine.
 *
 * `validateJobOptions` admits every value 2.9.10 ran with a well-defined result;
 * `normalizeJobInput` turns it into the value 2.9.10 effectively used, so all
 * admission paths (embedded, TCP, HTTP, flows, cron templates, MCP, Cloud, the
 * PostgreSQL engine and direct QueueManager calls) store the same job:
 * - a plain decimal numeric string becomes its number (2.9.10 coerced `'3'` in
 *   arithmetic; `delay: '1000'` and `timeout: '50'` were broken by string `+`);
 * - `maxAttempts` follows `attemptCount` (1 or less runs once, a fraction rounds up,
 *   Infinity and huge values are the INTEGER maximum);
 * - finite `delay`, `timeout`, `ttl`, `dedup.ttl`, `debounceTtl` and `repeat.every`
 *   beyond the honoured range (±MAX_JOB_DURATION_MS) are clamped to it.
 * Everything else is kept as given. Values validation would refuse (NaN, ±Infinity,
 * objects) are left untouched: a direct caller that stores one gets the shared rules'
 * 2.9.10 meaning (a ±Infinity or NaN `timeout` is no timeout, `timeoutRule.ts`), never a
 * finite deadline made up here; createJob applies its own fallbacks.
 *
 * Hot path (once per admitted job): a few type checks, and a copy only when a field
 * changes.
 */

import type { JobInput } from '../types/jobs/model';
import { attemptCount, clampDuration, coerceNumericString } from './optionBounds';

/** A finite duration clamped to the honoured range; ±Infinity is kept (see above). */
function clampFinite(value: number): number {
  return Number.isFinite(value) ? clampDuration(value) : value;
}

type NumericKey =
  | 'priority'
  | 'delay'
  | 'timeout'
  | 'maxAttempts'
  | 'ttl'
  | 'stallTimeout'
  | 'timestamp'
  | 'stackTraceLimit'
  | 'keepLogs'
  | 'sizeLimit'
  | 'debounceTtl'
  | 'groupMaxSize';

const NUMERIC_FIELDS: ReadonlyArray<readonly [NumericKey, ((value: number) => number) | null]> = [
  ['priority', null],
  ['delay', clampFinite],
  ['timeout', clampFinite],
  ['maxAttempts', attemptCount],
  ['ttl', clampFinite],
  ['stallTimeout', null],
  ['timestamp', null],
  ['stackTraceLimit', null],
  ['keepLogs', null],
  ['sizeLimit', null],
  ['debounceTtl', clampFinite],
  ['groupMaxSize', null],
];

/** `value` read as a number (a numeric string coerced), then `normalize`d; else unchanged. */
function normalized(value: unknown, normalize: ((value: number) => number) | null): unknown {
  const number = coerceNumericString(value);
  return typeof number === 'number' && normalize ? normalize(number) : number;
}

/** A copy of `object` with `key` set to its normalized value, or `object` when unchanged. */
function withNormalized<T extends object>(
  object: T,
  key: keyof T,
  normalize: ((value: number) => number) | null
): T {
  const value = object[key];
  if (value === undefined || value === null) return object;
  const next = normalized(value, normalize);
  return Object.is(next, value) ? object : { ...object, [key]: next };
}

function normalizedBackoff(backoff: JobInput['backoff']): JobInput['backoff'] {
  if (typeof backoff === 'object' && backoff !== null) {
    return withNormalized(withNormalized(backoff, 'delay', null), 'maxDelay', null);
  }
  return backoff === undefined || backoff === null
    ? backoff
    : (coerceNumericString(backoff) as JobInput['backoff']);
}

/** `input` with its option values in their stored form (see the module comment). */
export function normalizeJobInput(input: JobInput): JobInput {
  let out: JobInput | null = null;
  for (const [key, normalize] of NUMERIC_FIELDS) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    const next = normalized(value, normalize);
    if (Object.is(next, value)) continue;
    out ??= { ...input };
    (out as Record<NumericKey, unknown>)[key] = next;
  }
  const backoff = normalizedBackoff(input.backoff);
  if (!Object.is(backoff, input.backoff)) {
    out ??= { ...input };
    out.backoff = backoff;
  }
  if (typeof input.dedup === 'object' && input.dedup !== null) {
    const dedup = withNormalized(input.dedup, 'ttl', clampFinite);
    if (dedup !== input.dedup) {
      out ??= { ...input };
      out.dedup = dedup;
    }
  }
  if (typeof input.repeat === 'object' && input.repeat !== null) {
    const repeat = withNormalized(input.repeat, 'every', clampFinite);
    if (repeat !== input.repeat) {
      out ??= { ...input };
      out.repeat = repeat;
    }
  }
  return out ?? input;
}
