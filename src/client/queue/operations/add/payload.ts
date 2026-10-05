import { effectiveJobDelay } from '../../../../domain/job/options';
import { clampDuration, coerceNumericString } from '../../../../domain/job/optionBounds';
import type { JobOptions } from '../../../types';
import type { ExtendedJobOptions } from '../../types/add';
import { normalizeGroupId } from '../../../groupId';

export function compact<T extends Record<string, unknown>>(object: T): T {
  const output: Record<string, unknown> = {};
  for (const key in object) {
    if (object[key] !== undefined) output[key] = object[key];
  }
  return output as T;
}

export function parseDate(date: Date | string | number | undefined): number | undefined {
  if (date instanceof Date) return date.getTime();
  if (typeof date === 'string') return new Date(date).getTime();
  return date;
}

export function buildRepeatOptions(repeat: NonNullable<JobOptions['repeat']>) {
  return {
    every: repeat.every,
    limit: repeat.limit,
    pattern: repeat.pattern,
    count: repeat.count,
    startDate: parseDate(repeat.startDate),
    endDate: parseDate(repeat.endDate),
    tz: repeat.tz,
    immediately: repeat.immediately,
    prevMillis: repeat.prevMillis,
    offset: repeat.offset,
    jobId: repeat.jobId,
  };
}

export function buildPushPayload(
  queue: string,
  name: string,
  data: unknown,
  options: ExtendedJobOptions
): Record<string, unknown> {
  return compact({
    cmd: 'PUSH',
    queue,
    name,
    data,
    priority: options.group?.priority ?? options.priority,
    delay: options.delay,
    maxAttempts: options.attempts,
    backoff: options.backoff,
    ttl: options.ttl,
    timeout: options.timeout,
    jobId: options.jobId,
    uniqueKey: options.deduplication?.id,
    dedup: options.deduplication
      ? {
          ttl: options.deduplication.ttl,
          extend: options.deduplication.extend,
          replace: options.deduplication.replace,
        }
      : undefined,
    dependsOn: options.dependsOn,
    tags: options.tags,
    groupId: resolveGroupId(options),
    groupMaxSize: options.group?.maxSize,
    lifo: options.lifo,
    removeOnComplete:
      typeof options.removeOnComplete === 'boolean' ? options.removeOnComplete : undefined,
    removeOnFail: typeof options.removeOnFail === 'boolean' ? options.removeOnFail : undefined,
    stallTimeout: options.stallTimeout,
    stackTraceLimit: options.stackTraceLimit,
    keepLogs: options.keepLogs,
    sizeLimit: options.sizeLimit,
    failParentOnFailure: options.failParentOnFailure,
    removeDependencyOnFailure: options.removeDependencyOnFailure,
    continueParentOnFailure: options.continueParentOnFailure,
    ignoreDependencyOnFailure: options.ignoreDependencyOnFailure,
    debounceId: options.debounce?.id,
    debounceTtl: options.debounce?.ttl,
    timestamp: options.timestamp,
    durable: options.durable,
    repeat: options.repeat,
    parentId: options.parent?.id,
  });
}

export function resolveGroupId(options: ExtendedJobOptions): string | undefined {
  if (options.group) return normalizeGroupId(options.group.id);
  return options.groupId === undefined ? undefined : normalizeGroupId(options.groupId);
}

export function buildJobData(data: unknown, options: ExtendedJobOptions): unknown {
  if (!options.parent) return data;
  return {
    ...(data as object),
    __parentId: options.parent.id,
    __parentQueue: options.parent.queue,
  };
}

/**
 * The public `delay`/`priority`/`opts` of a job just added, as the broker reports them: a
 * negative delay (a ready job whose run time is in the past) is reported as 0, as a job
 * read back from the broker is; a numeric string is its number, and a delay beyond the
 * honoured range is clamped (see normalizeJobInput).
 */
export function reflectionMeta(options: ExtendedJobOptions): {
  priority?: number;
  delay?: number;
  opts: JobOptions;
} {
  const delay =
    options.delay === undefined
      ? undefined
      : clampDuration(effectiveJobDelay(coerceNumericString(options.delay)));
  const priority = coerceNumericString(options.group?.priority ?? options.priority) as
    | number
    | undefined;
  return {
    priority,
    delay,
    opts: delay === options.delay ? options : { ...options, delay },
  };
}
