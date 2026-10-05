/**
 * Job option bounds and the one validator every admission path uses.
 *
 * TCP PUSH/PUSHB (and HTTP), atomic flows, embedded `Queue.add`/`addBulk`, MCP, Cloud
 * and cron/job-scheduler templates all call `validateJobOptions`, so embedded and TCP
 * mode accept the same input. The bounds refuse only what cannot be honoured (see
 * `optionBounds.ts`): every value 2.9.10 ran with a well-defined result is admitted,
 * and `normalizeJobInput` (applied by the engine and by createJob) stores it the way
 * 2.9.10 effectively used it. Messages name the option as the caller passed it:
 * wire names for TCP/HTTP commands (`maxAttempts`, `dedup.ttl`, `debounceTtl`), and
 * `CALLER_OPTION_NAMES` (`attempts`, `deduplication.ttl`, `debounce.ttl`) for the
 * client SDK, flows and job schedulers.
 *
 * Validators return the first error message or null; the `assert*` forms throw it as
 * an `Error`. See docs/features/job-options-validation.md.
 */

import { validateGroupPriority, validatePositiveSafeInteger } from '../types/group';
import { MAX_BACKOFF_DELAY } from './constants';
import {
  attemptsError,
  type Bounds,
  clampDuration,
  coerceNumericString,
  FINITE,
  MAX_DATE_MS,
  MAX_JOB_DURATION_MS,
  numberError,
} from './optionBounds';

export { MAX_DATE_MS, MAX_JOB_DURATION_MS, MAX_JOB_ATTEMPTS } from './optionBounds';
export { normalizeJobInput } from './optionNormalize';
export {
  assertDelayArgument,
  assertLockDuration,
  assertPullTimeout,
  delayArgument,
  LOCK_NOT_EXTENDED_ERROR,
  pullTimeoutArgument,
  validateDelayArgument,
  validateLockDuration,
  validatePullTimeout,
} from './commandArguments';

/** The longest honoured `delay` (also `ttl`, `dedup.ttl`, `debounceTtl`, `repeat.every`). */
export const MAX_JOB_DELAY_MS = MAX_JOB_DURATION_MS;
/** `timestamp`: early and late enough that `timestamp + delay` stays a valid date. */
const MAX_JOB_TIMESTAMP_MS = MAX_DATE_MS - MAX_JOB_DURATION_MS;

/** Inclusive bounds of one numeric field. */
export interface NumericFieldOptions {
  min?: number;
  max?: number;
  required?: boolean;
  integer?: boolean;
}

/** A job's `delay`: negative is a run time in the past, ready at once (see `jobRunDelay`). */
const JOB_DELAY: Bounds = { min: Number.NEGATIVE_INFINITY, max: MAX_JOB_DURATION_MS, clamp: true };
/** `timeout` and `ttl`: 0 or more (a negative value expired or timed the job out at once). */
const DURATION: Bounds = { min: 0, max: MAX_JOB_DURATION_MS, clamp: true };
/** `dedup.ttl` and `debounceTtl`: any finite value (a negative one has already expired). */
const ANY_DURATION: Bounds = { ...FINITE, max: MAX_JOB_DURATION_MS, clamp: true };
/** `backoff` and `backoff.delay`: the retry delay is capped by `backoff.maxDelay` anyway. */
const BACKOFF: Bounds = { min: 0, max: Number.POSITIVE_INFINITY };
/** `backoff.maxDelay`: 0 to 24 hours (2.9.10 silently replaced a larger cap with 1 hour). */
const MAX_DELAY: Bounds = { min: 0, max: MAX_BACKOFF_DELAY };
const TIMESTAMP: Bounds = { min: -MAX_JOB_TIMESTAMP_MS, max: MAX_JOB_TIMESTAMP_MS };

/** Legacy callers of validateNumericField rely on these names being integers. */
const INTEGER_FIELDS = new Set(['priority', 'attempts', 'maxAttempts']);

/**
 * Validate one numeric command field (default bounds 0..MAX_SAFE_INTEGER). The value is
 * passed on as it is, so a numeric string is not a number here (as on 2.9.10).
 */
export function validateNumericField(
  value: unknown,
  name: string,
  options: NumericFieldOptions = {}
): string | null {
  return numberError(
    value,
    '',
    name,
    {
      min: options.min ?? 0,
      max: options.max ?? Number.MAX_SAFE_INTEGER,
      required: options.required,
      integer: options.integer ?? INTEGER_FIELDS.has(name),
    },
    false
  );
}

/**
 * `backoff`: a number of ms, or `{ type, delay?, maxDelay? }`. `type` is free, as on
 * 2.9.10: `'fixed'` is fixed, anything else (`'exponential'`, `'linear'`, BullMQ's
 * `'custom'`) runs as exponential. A missing `delay` is the default base, 1000 ms
 * (createJob's fallback; 2.9.10 lost such a job on a SQLite NOT NULL). A NaN, negative
 * or non-numeric `delay` is refused.
 */
export function validateBackoffField(value: unknown, prefix = ''): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return (
      numberError(object['delay'], prefix, 'backoff.delay', BACKOFF) ??
      numberError(object['maxDelay'], prefix, 'backoff.maxDelay', MAX_DELAY)
    );
  }
  return numberError(value, prefix, 'backoff', BACKOFF);
}

/** `repeat.every`: a positive finite interval (a longer one than the maximum is clamped). */
function repeatEveryError(repeat: unknown, prefix: string): string | null {
  if (typeof repeat !== 'object' || repeat === null) return null;
  const raw = (repeat as { every?: unknown }).every;
  if (raw === undefined || raw === null) return null;
  const every = coerceNumericString(raw);
  if (typeof every !== 'number' || !Number.isFinite(every) || every <= 0) {
    return `${prefix}repeat.every must be a positive finite number`;
  }
  return null;
}

function nestedTtl(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? (value as { ttl?: unknown }).ttl : undefined;
}

/** The bounded fields, under their wire names. Every field is optional. */
export interface JobOptionFields {
  readonly priority?: unknown;
  readonly groupId?: unknown;
  readonly groupMaxSize?: unknown;
  readonly delay?: unknown;
  readonly timeout?: unknown;
  readonly maxAttempts?: unknown;
  readonly backoff?: unknown;
  readonly ttl?: unknown;
  readonly stallTimeout?: unknown;
  readonly timestamp?: unknown;
  readonly stackTraceLimit?: unknown;
  readonly keepLogs?: unknown;
  readonly sizeLimit?: unknown;
  readonly dedup?: unknown;
  readonly debounceTtl?: unknown;
  readonly repeat?: unknown;
}

/** How messages name the fields whose wire name differs from the SDK option. */
export interface JobOptionNames {
  readonly maxAttempts: string;
  readonly dedupTtl: string;
  readonly debounceTtl: string;
}

/** TCP/HTTP command fields, as the caller of a PUSH sends them. */
export const WIRE_OPTION_NAMES: JobOptionNames = {
  maxAttempts: 'maxAttempts',
  dedupTtl: 'dedup.ttl',
  debounceTtl: 'debounceTtl',
};

/** SDK `JobOptions` (Queue.add, FlowProducer, job schedulers). */
export const CALLER_OPTION_NAMES: JobOptionNames = {
  maxAttempts: 'attempts',
  dedupTtl: 'deduplication.ttl',
  debounceTtl: 'debounce.ttl',
};

/** The group priority rule (0..2,097,151, integer), with a numeric string read as its number. */
function groupPriorityError(priority: unknown): string | null {
  return validateGroupPriority(coerceNumericString(priority));
}

/**
 * Validate the bounded options of one job (a PUSH command, a PUSHB/flow `JobInput`, an
 * embedded add, a cron template). `prefix` is prepended to every field name, e.g.
 * `jobOptions.` for a cron template. Returns the first error, or null.
 */
export function validateJobOptions(
  options: JobOptionFields,
  prefix = '',
  names: JobOptionNames = WIRE_OPTION_NAMES
): string | null {
  const o = options;
  return (
    (o.groupId === undefined
      ? numberError(o.priority, prefix, 'priority', FINITE)
      : groupPriorityError(o.priority)) ??
    numberError(o.delay, prefix, 'delay', JOB_DELAY) ??
    numberError(o.timeout, prefix, 'timeout', DURATION) ??
    attemptsError(o.maxAttempts, prefix, names.maxAttempts) ??
    validateBackoffField(o.backoff, prefix) ??
    numberError(o.ttl, prefix, 'ttl', DURATION) ??
    numberError(o.stallTimeout, prefix, 'stallTimeout', FINITE) ??
    numberError(o.timestamp, prefix, 'timestamp', TIMESTAMP) ??
    numberError(o.stackTraceLimit, prefix, 'stackTraceLimit', FINITE) ??
    numberError(o.keepLogs, prefix, 'keepLogs', FINITE) ??
    numberError(o.sizeLimit, prefix, 'sizeLimit', FINITE) ??
    (o.groupMaxSize === undefined || o.groupMaxSize === null
      ? null
      : validatePositiveSafeInteger(coerceNumericString(o.groupMaxSize), 'group.maxSize')) ??
    numberError(nestedTtl(o.dedup), prefix, names.dedupTtl, ANY_DURATION) ??
    numberError(o.debounceTtl, prefix, names.debounceTtl, ANY_DURATION) ??
    repeatEveryError(o.repeat, prefix)
  );
}

/**
 * The delay a job's `runAt` is computed with (`runAt = createdAt + delay`), as on 2.9.10:
 * a negative delay is kept, so the job is ready with a run time in the past and the
 * waiting-queue order (by `runAt`) puts it ahead of later ready jobs; it is bounded to
 * ±MAX_JOB_DURATION_MS. NaN or a non-number (only internal callers skip validation) is 0.
 */
export function jobRunDelay(delay: unknown): number {
  return typeof delay === 'number' && delay === delay ? clampDuration(delay) : 0;
}

/**
 * The delay a job reports (`job.delay`, `job.opts.delay`): its run delay when positive,
 * else 0, as a job read back from the broker reports `runAt - createdAt` only when the
 * job is delayed.
 */
export function effectiveJobDelay(delay: unknown): number {
  return typeof delay === 'number' && delay > 0 ? delay : 0;
}

/** Throw the first `validateJobOptions` error as an `Error`. */
export function assertJobOptions(
  options: JobOptionFields,
  prefix = '',
  names: JobOptionNames = WIRE_OPTION_NAMES
): void {
  const error = validateJobOptions(options, prefix, names);
  if (error) throw new Error(error);
}
