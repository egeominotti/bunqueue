import { assertValidCronTiming, type CronJobInput } from '../../../domain/types/cron';
import { MAX_JOB_DELAY_MS, validateJobOptions } from '../../../domain/job/options';
import { expandCronShortcut, validateCronExpression } from '../cronParser';

/** The cron fields the job-option bounds apply to (a CronJobInput or a stored CronJob). */
export interface CronTemplateFields {
  readonly repeatEvery?: number | null;
  readonly priority?: number | null;
  readonly dedup?: CronJobInput['dedup'] | null;
  readonly jobOptions?: CronJobInput['jobOptions'] | null;
}

/**
 * The first violation of the bounds `addCron` enforces beyond timing syntax, or null:
 * - `repeatEvery` at most the honoured job duration (`MAX_JOB_DELAY_MS`, about 136,900
 *   years), which keeps every nextRun a valid date;
 * - the options every spawned job carries, with the PUSH rules, so a cron cannot admit
 *   a job a PUSH would refuse. These refuse only what cannot run (NaN, a negative
 *   timeout or `backoff.delay`, ...; a backoff object without `delay` uses the 1000 ms
 *   default): every template 2.9.10 stored and ran is accepted, and each spawned job is
 *   normalized like an added one. Only the
 *   template fields the scheduler applies are checked (`fireCronJob`); unknown
 *   template keys stay ignored.
 */
export function cronTemplateError(input: CronTemplateFields): string | null {
  if (typeof input.repeatEvery === 'number' && input.repeatEvery > MAX_JOB_DELAY_MS) {
    return `Cron repeatEvery must be at most ${MAX_JOB_DELAY_MS} milliseconds`;
  }
  const shared = validateJobOptions({ priority: input.priority, dedup: input.dedup });
  if (shared) return shared;
  const template = input.jobOptions;
  if (typeof template !== 'object' || template === null) return null;
  return validateJobOptions(
    {
      maxAttempts: template.maxAttempts,
      backoff: template.backoff,
      timeout: template.timeout,
      delay: template.delay,
      stallTimeout: template.stallTimeout,
    },
    'jobOptions.'
  );
}

/** Reject invalid timing, calendar syntax, timezones and job options before state mutation. */
export function assertValidCronInput(input: CronJobInput): void {
  assertValidCronTiming(input);
  const templateError = cronTemplateError(input);
  if (templateError) throw new Error(templateError);
  if (!input.schedule) return;
  const error = validateCronExpression(expandCronShortcut(input.schedule), input.timezone);
  if (error) throw new Error(`Invalid cron expression: ${error}`);
}
