/**
 * Input schema of bunqueue_add_cron beyond the timing fields, and its mapping to the
 * engine's CronJobInput. Every option is honored end to end by both backends: the
 * embedded QueueManager receives the input directly and the TCP broker's `Cron` command
 * passes the same fields to the same scheduler.
 */

import { z } from 'zod';
import type { CronJobInput, CronJobOptions } from '../../domain/types/cron';
import {
  attemptsField,
  backoffField,
  deduplicationField,
  delayField,
  jobNameField,
  priorityField,
  stallTimeoutField,
  timeoutField,
} from './schemas';

/** True when the scheduler's own cron engine resolves `tz` (an IANA zone such as "Europe/Rome"). */
function isKnownTimezone(tz: string): boolean {
  try {
    Bun.cron.parse('0 0 * * *', Date.now(), { tz });
    return true;
  } catch {
    return false;
  }
}

function timezoneField() {
  return z
    .string()
    .min(1)
    .refine(isKnownTimezone, {
      message: 'Unknown time zone: use an IANA name such as "Europe/Rome" or "America/New_York"',
    })
    .describe('IANA time zone of the cron pattern, e.g. "Europe/Rome" (default: UTC)');
}

export function cronOptionsShape() {
  return {
    jobName: jobNameField('Name of every job the schedule adds (default: "default")').optional(),
    priority: priorityField('Priority of every job the schedule adds (default: 0)').optional(),
    timezone: timezoneField().optional(),
    maxLimit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Remove the schedule after this many runs (default: unlimited)'),
    immediately: z
      .boolean()
      .optional()
      .describe('Also run once right away when the schedule is first created'),
    skipIfNoWorker: z
      .boolean()
      .optional()
      .describe('Skip runs while no worker is registered for the queue (default: false)'),
    preventOverlap: z
      .boolean()
      .optional()
      .describe('Add nothing while the previous job is still pending or active (default: true)'),
    skipMissedOnRestart: z
      .boolean()
      .optional()
      .describe('After a restart, skip runs missed while the server was down (default: true)'),
    deduplication: deduplicationField()
      .optional()
      .describe("Deduplicate the schedule's jobs by this key instead of the overlap key"),
    attempts: attemptsField('Max attempts of every job the schedule adds (default: 3)').optional(),
    backoff: backoffField().optional(),
    timeout: timeoutField().optional(),
    delay: delayField('Delay in ms before each added job becomes ready').optional(),
    stallTimeout: stallTimeoutField().optional(),
    removeOnComplete: z.boolean().optional().describe('Delete each added job once it completes'),
    removeOnFail: z
      .boolean()
      .optional()
      .describe('Delete each added job instead of moving it to the DLQ on final failure'),
  };
}

export type CronOptionsArgs = z.infer<z.ZodObject<ReturnType<typeof cronOptionsShape>>>;

export interface CronTimingArgs {
  name: string;
  queue: string;
  data: Record<string, unknown>;
  schedule?: string;
  repeatEvery?: number;
}

function jobOptions(args: CronOptionsArgs): CronJobOptions | undefined {
  const options: CronJobOptions = {
    ...(args.attempts === undefined ? {} : { maxAttempts: args.attempts }),
    ...(args.backoff === undefined ? {} : { backoff: args.backoff }),
    ...(args.timeout === undefined ? {} : { timeout: args.timeout }),
    ...(args.delay === undefined ? {} : { delay: args.delay }),
    ...(args.stallTimeout === undefined ? {} : { stallTimeout: args.stallTimeout }),
    ...(args.removeOnComplete === undefined ? {} : { removeOnComplete: args.removeOnComplete }),
    ...(args.removeOnFail === undefined ? {} : { removeOnFail: args.removeOnFail }),
  };
  return Object.keys(options).length > 0 ? options : undefined;
}

/** The engine input for bunqueue_add_cron; throws on combinations the scheduler would ignore. */
export function toCronInput(args: CronTimingArgs & CronOptionsArgs): CronJobInput {
  if (args.timezone !== undefined && !args.schedule) {
    throw new Error('timezone applies only to a cron pattern: set schedule, or omit timezone');
  }
  const dedup = args.deduplication;
  const dedupOptions =
    dedup && (dedup.ttl !== undefined || dedup.extend !== undefined || dedup.replace !== undefined)
      ? { ttl: dedup.ttl, extend: dedup.extend, replace: dedup.replace }
      : undefined;
  return {
    name: args.name,
    queue: args.queue,
    data: args.data,
    schedule: args.schedule,
    repeatEvery: args.repeatEvery,
    jobName: args.jobName,
    priority: args.priority,
    timezone: args.timezone,
    maxLimit: args.maxLimit,
    immediately: args.immediately,
    skipIfNoWorker: args.skipIfNoWorker,
    preventOverlap: args.preventOverlap,
    skipMissedOnRestart: args.skipMissedOnRestart,
    uniqueKey: dedup?.id,
    dedup: dedupOptions,
    jobOptions: jobOptions(args),
  };
}
