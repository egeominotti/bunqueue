import { assertValidCronTiming, type CronJob } from '../../../domain/types/cron';
import { cronLog } from '../../../shared/logger';
import { expandCronShortcut, validateCronExpression } from '../cronParser';
import { cronTemplateError } from './validation';

const NATIVE_CRON_MIGRATION_VERSION = '2.9.0';

/** Reject persisted Croner-only syntax before any scheduler state is mutated. */
export function assertPersistedCronSupported(cron: CronJob): void {
  try {
    assertValidCronTiming(cron);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Persisted cron ${JSON.stringify(cron.name)} has invalid timing: ${message}. ` +
        `Update or remove it before upgrading to bunqueue ${NATIVE_CRON_MIGRATION_VERSION}.`
    );
  }
  if (!cron.schedule) return;
  const error = validateCronExpression(
    expandCronShortcut(cron.schedule),
    cron.timezone ?? undefined
  );
  if (!error) return;
  throw new Error(
    `Persisted cron ${JSON.stringify(cron.name)} uses unsupported schedule ${JSON.stringify(cron.schedule)}. ` +
      `Update or remove it before upgrading to bunqueue ${NATIVE_CRON_MIGRATION_VERSION}. ` +
      `Bun.cron validation failed: ${error}`
  );
}

/** Definitions already reported, so the SQLite pre-check and the load warn once. */
const reportedTemplates = new WeakSet<CronJob>();

/**
 * Warn once per persisted cron whose template breaks the bounds `addCron` now enforces
 * (job options, priority, `dedup.ttl`, `repeatEvery` above `MAX_JOB_DELAY_MS`). It is not
 * rejected: an older release stored it, and failing startup over it would take every
 * other queue down. It keeps running with its stored values until it is updated.
 */
function warnInvalidTemplate(cron: CronJob): void {
  if (reportedTemplates.has(cron)) return;
  reportedTemplates.add(cron);
  const problem = cronTemplateError(cron);
  if (!problem) return;
  cronLog.warn(
    `Persisted cron ${JSON.stringify(cron.name)} has an invalid job template: ${problem}. ` +
      'It still runs with its stored values; re-add it with valid options to fix it.',
    { name: cron.name, queue: cron.queue, problem }
  );
}

/**
 * Validate a persisted collection atomically before loading any definition, and warn
 * about templates that predate the job-option bounds (load paths only).
 */
export function assertPersistedCronsSupported(crons: readonly CronJob[]): void {
  for (const cron of crons) assertPersistedCronSupported(cron);
  for (const cron of crons) warnInvalidTemplate(cron);
}
