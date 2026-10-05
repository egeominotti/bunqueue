import type { BackoffConfig, Job, JobId, JobInput, RepeatConfig } from '../types/jobs/model';
import { JOB_DEFAULTS, MAX_BACKOFF_DELAY } from './constants';
import { jobRunDelay } from './options';
import { normalizeJobInput } from './optionNormalize';
import { normalizeJobPayload } from './payload';

/**
 * Keep a caller-supplied retry-delay cap only when it is usable. Every public path
 * validates options first (`validateJobOptions`), but internal callers, legacy cron
 * templates and stored rows do not, so a non-numeric, non-finite, negative or
 * over-limit value is dropped and the default cap applies instead of turning the
 * retry delay into NaN or an unbounded wait.
 */
export function parseMaxDelay(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value >= 0 && value <= MAX_BACKOFF_DELAY ? value : undefined;
}

/**
 * `value` when it is a number other than NaN, else `fallback`. createJob never stores
 * NaN (or a non-number) in a field SQLite keeps NOT NULL (created_at, run_at,
 * backoff, priority, max_attempts): the write buffer would drop the row, and a NaN
 * run time never comes due. Boundary validation rejects these values; this only
 * protects internal callers.
 */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && value === value ? value : fallback;
}

function parseBackoff(input: JobInput['backoff'] | null): {
  backoff: number;
  backoffConfig: BackoffConfig | null;
} {
  if (typeof input === 'object' && input !== null) {
    const maxDelay = parseMaxDelay(input.maxDelay);
    // A missing `delay` is valid input (`{ type: 'exponential' }`): the default base.
    const delay = numberOr(input.delay, JOB_DEFAULTS.backoff);
    return {
      backoff: delay,
      backoffConfig:
        maxDelay === undefined
          ? { type: input.type, delay }
          : { type: input.type, delay, maxDelay },
    };
  }
  return { backoff: numberOr(input, JOB_DEFAULTS.backoff), backoffConfig: null };
}

function parseRepeatConfig(repeat: JobInput['repeat']): RepeatConfig | null {
  if (!repeat) return null;
  return {
    every: repeat.every,
    limit: repeat.limit,
    pattern: repeat.pattern,
    count: repeat.count ?? 0,
    startDate: repeat.startDate,
    endDate: repeat.endDate,
    tz: repeat.tz,
    immediately: repeat.immediately,
    prevMillis: repeat.prevMillis,
    offset: repeat.offset,
    jobId: repeat.jobId,
  };
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return value === undefined ? fallback : Boolean(value);
}

function parseCoreOptions(input: JobInput) {
  return {
    priority: numberOr(input.priority, JOB_DEFAULTS.priority),
    // A boolean, as the heap comparator requires: `1` and `true` each sorted first (#90).
    lifo: toBoolean(input.lifo, JOB_DEFAULTS.lifo),
    maxAttempts: numberOr(input.maxAttempts, JOB_DEFAULTS.maxAttempts),
    removeOnComplete: toBoolean(input.removeOnComplete, JOB_DEFAULTS.removeOnComplete),
    removeOnFail: toBoolean(input.removeOnFail, JOB_DEFAULTS.removeOnFail),
  };
}

function parseOptionalFields(input: JobInput) {
  return {
    ttl: input.ttl ?? null,
    timeout: input.timeout ?? null,
    uniqueKey: input.uniqueKey ?? null,
    customId: input.customId ?? null,
    parentId: input.parentId ?? null,
    groupId: input.groupId ?? null,
    stallTimeout: input.stallTimeout ?? null,
  };
}

function parseBullMQV5Options(input: JobInput) {
  return {
    stackTraceLimit: input.stackTraceLimit ?? JOB_DEFAULTS.stackTraceLimit,
    keepLogs: input.keepLogs ?? null,
    sizeLimit: input.sizeLimit ?? null,
    failParentOnFailure: input.failParentOnFailure ?? false,
    removeDependencyOnFailure: input.removeDependencyOnFailure ?? false,
    continueParentOnFailure: input.continueParentOnFailure ?? false,
    ignoreDependencyOnFailure: input.ignoreDependencyOnFailure ?? false,
    deduplicationTtl: input.dedup?.ttl ?? null,
    deduplicationExtend: input.dedup?.extend ?? false,
    deduplicationReplace: input.dedup?.replace ?? false,
    debounceId: input.debounceId ?? null,
    debounceTtl: input.debounceTtl ?? null,
  };
}

export function createJob(
  id: JobId,
  queue: string,
  rawInput: JobInput,
  now: number = Date.now()
): Job {
  // The stored form of the options (numeric strings, attempts, clamped durations), for
  // every caller: engines normalize at admission too, internal callers rely on this.
  const input = normalizeJobInput(rawInput);
  const { backoff, backoffConfig } = parseBackoff(input.backoff);
  const coreOpts = parseCoreOptions(input);
  const optionalFields = parseOptionalFields(input);
  const v5Opts = parseBullMQV5Options(input);
  const createdAt = numberOr(input.timestamp, now);
  const payload = normalizeJobPayload(input);

  return {
    id,
    queue,
    name: payload.name,
    data: payload.data,
    createdAt,
    // As on 2.9.10, a negative delay keeps its past run time: the job is ready (never
    // delayed) and sorts ahead of later ready jobs (bounded by jobRunDelay).
    runAt: createdAt + jobRunDelay(input.delay),
    startedAt: null,
    completedAt: null,
    attempts: 0,
    backoff,
    backoffConfig,
    dependsOn: input.dependsOn ?? [],
    childrenIds: input.childrenIds ?? [],
    childrenCompleted: 0,
    tags: input.tags ?? [],
    progress: 0,
    progressMessage: null,
    stacktrace: null,
    repeat: parseRepeatConfig(input.repeat),
    durable: input.durable ?? false,
    lastHeartbeat: createdAt,
    stallCount: 0,
    ...coreOpts,
    ...optionalFields,
    ...v5Opts,
    timeline: [],
  };
}
