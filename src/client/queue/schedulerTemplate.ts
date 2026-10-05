/**
 * Job scheduler templates: how a `JobTemplate` maps onto the cron fields the broker
 * stores (BullMQ v5 repeatable jobs). The template options are checked here with the
 * add rules, named as the caller passed them (`attempts`, `deduplication.ttl`), and
 * the broker checks the stored fields again (`assertValidCronInput`). Both refuse only
 * what a job cannot run with: every template 2.9.10 stored and ran is accepted (an
 * application re-upserts its schedulers at boot).
 */

import { CALLER_OPTION_NAMES, validateJobOptions } from '../../domain/job/options';
import type { CronJobOptions } from '../../domain/types/cron';
import type { JobOptions } from '../types';

export interface JobTemplate<T = unknown> {
  name?: string;
  data?: T;
  opts?: JobOptions;
}

/** Build cron job data from template */
export function buildCronData(jobTemplate?: JobTemplate): unknown {
  return jobTemplate?.data ?? {};
}

/**
 * Build the job options carried by every cron-spawned job (issue #86).
 * Queue defaultJobOptions are the base; per-scheduler template opts override.
 * Returns undefined when nothing relevant is set so the server keeps its
 * own JOB_DEFAULTS fallback.
 */
export function buildCronJobOptions(
  defaultJobOptions: JobOptions | undefined,
  jobTemplate?: JobTemplate
): CronJobOptions | undefined {
  const merged: JobOptions = { ...defaultJobOptions, ...jobTemplate?.opts };
  const opts: { -readonly [K in keyof CronJobOptions]: CronJobOptions[K] } = {};
  if (merged.attempts !== undefined) opts.maxAttempts = merged.attempts;
  if (merged.backoff !== undefined) opts.backoff = merged.backoff;
  if (merged.timeout !== undefined) opts.timeout = merged.timeout;
  if (merged.delay !== undefined) opts.delay = merged.delay;
  if (merged.stallTimeout !== undefined) opts.stallTimeout = merged.stallTimeout;
  if (typeof merged.removeOnComplete === 'boolean') opts.removeOnComplete = merged.removeOnComplete;
  if (typeof merged.removeOnFail === 'boolean') opts.removeOnFail = merged.removeOnFail;
  return Object.keys(opts).length > 0 ? opts : undefined;
}

/**
 * The first template option no spawned job could run with, named as the caller passed it
 * (`attempts`, `deduplication.ttl`), or null. Queue defaultJobOptions are the base, as in
 * buildCronJobOptions. The caller reports it as the mode did on 2.9.10: embedded throws,
 * TCP resolves null (as for a schedule the broker refuses).
 */
export function cronTemplateOptionsError(
  defaultJobOptions: JobOptions | undefined,
  jobTemplate?: JobTemplate
): string | null {
  const merged: JobOptions = { ...defaultJobOptions, ...jobTemplate?.opts };
  return validateJobOptions(
    {
      priority: merged.priority,
      maxAttempts: merged.attempts,
      backoff: merged.backoff,
      timeout: merged.timeout,
      delay: merged.delay,
      stallTimeout: merged.stallTimeout,
      dedup: jobTemplate?.opts?.deduplication,
    },
    '',
    CALLER_OPTION_NAMES
  );
}

/** Extract dedup config from job template */
export function buildCronDedup(jobTemplate?: JobTemplate) {
  const dedup = jobTemplate?.opts?.deduplication;
  if (!dedup) return { uniqueKey: undefined, dedup: undefined };
  return {
    uniqueKey: dedup.id,
    dedup: { ttl: dedup.ttl, extend: dedup.extend, replace: dedup.replace },
  };
}
