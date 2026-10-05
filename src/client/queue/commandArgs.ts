/**
 * Client-side checks of job command arguments, in both modes.
 *
 * The broker validates ChangeDelay, MoveToDelayed and ExtendLock, but several TCP
 * call paths ignore the reply (an unknown job is not an error for them), so a NaN
 * delay was rejected silently over TCP and stored as a never-due run time embedded.
 * Checking here, with the broker's own validators, makes both modes throw the
 * message a TCP command returns, before anything is sent. Only what cannot be applied
 * is refused: every argument 2.9.10 applied keeps its 2.9.10 result.
 */

import {
  assertDelayArgument,
  assertLockDuration,
  delayArgument,
  LOCK_NOT_EXTENDED_ERROR,
} from '../../domain/job/options';
import {
  DATA_NOT_UPDATED_ERROR,
  DELAY_NOT_CHANGED_ERROR,
  JOB_NOT_DELAYED_ERROR,
  normalizeProgress,
  PRIORITY_NOT_CHANGED_ERROR,
  PROGRESS_JOB_NOT_FOUND_ERROR,
  PROGRESS_NOT_ACTIVE_ERROR,
} from '../../domain/job/mutations';
import { coerceNumericString } from '../../domain/job/optionBounds';

/**
 * `changeDelay(delay)`: any finite delay. A negative one (`runAt - Date.now()` once
 * `runAt` has passed) makes the job ready with that past run time, as on 2.9.10.
 */
export function assertJobDelay(delay: unknown): void {
  assertDelayArgument(delay);
}

/**
 * `extendLock(token, duration)`: any finite duration, as the broker accepts it (2.9.10
 * resolved `extendLock(token, 0)` with 0). NaN or an infinity throws.
 */
export function assertLockExtension(duration: unknown): void {
  assertLockDuration(duration, 'duration');
}

/**
 * The relative delay of `moveToDelayed(timestamp)`: `max(0, timestamp - now)`, as the
 * 2.9.10 client computed it (a past timestamp means "now"; a plain decimal string is its
 * number, as 2.9.10's `timestamp - Date.now()` coerced it), and a run time beyond the
 * honoured range is clamped to it (`delayArgument`).
 */
export function delayUntil(rawTimestamp: unknown): number {
  const timestamp = coerceNumericString(rawTimestamp);
  if (typeof timestamp !== 'number') throw new Error('timestamp must be a number');
  if (!Number.isFinite(timestamp)) throw new Error('timestamp must be a finite number');
  const delay = delayArgument(timestamp - Date.now());
  return delay > 0 ? delay : 0;
}

/**
 * The result of a TCP `ExtendLock` for `job.extendLock`: `duration` when the lease was
 * extended, 0 when the broker found no matching lease (as embedded mode and BullMQ
 * report it), and a thrown error for any other rejection (validation, authentication,
 * a server fault), which embedded mode would throw too.
 */
export function lockExtensionResult(response: Record<string, unknown>, duration: number): number {
  if (response.ok === true) return duration;
  const error = response.error;
  if (typeof error !== 'string' || error === LOCK_NOT_EXTENDED_ERROR) return 0;
  throw new Error(error);
}

/**
 * The wire form of `job.updateProgress(progress, message?)` on every path (Worker,
 * SandboxedWorker, Queue, flow and DLQ jobs): the broker's `normalizeProgress`. It never
 * throws, so an `updateProgress('50%')` cannot fail the job, as it did not on 2.9.10:
 * an object is 0 with its JSON as the message, `'50'`/`true`/`null` are 50/1/0, other
 * text is 0 with the text as the message, NaN is 0.
 */
export function progressUpdate(
  progress: unknown,
  message?: string
): { progress: number; message?: string } {
  return normalizeProgress(progress, message);
}

/**
 * Replies of the TCP job setters, read the same way on every client path so embedded and
 * TCP mode report one outcome (docs/features/job-options-validation.md):
 * - any rejection throws the broker's message, except
 * - a "not applied" reply of `promote`, progress, `changePriority` and `changeDelay`
 *   (the job is no longer delayed, active or queued, or is gone), which resolves without
 *   change, as 2.9.10 did and as embedded mode ignores a false result.
 * Embedded `updateData` turns a false result into the broker's message (a lost update
 * must not pass silently), as TCP `Queue.updateJobData` did on 2.9.10.
 */
function rejectUnless(
  response: Record<string, unknown>,
  command: string,
  notApplied?: (error: string) => boolean
): void {
  if (response.ok === true) return;
  const error = response.error;
  if (typeof error !== 'string') {
    if (notApplied) return; // no message to report: "not applied"
    throw new Error(`${command} failed`);
  }
  if (notApplied?.(error)) return;
  throw new Error(error);
}

/** ChangePriority: a job that is not queued is not changed; anything else throws. */
export function assertPriorityChanged(response: Record<string, unknown>): void {
  rejectUnless(response, 'ChangePriority', (error) => error === PRIORITY_NOT_CHANGED_ERROR);
}

/** Promote: a job that is not delayed stays as it is; anything else throws. */
export function assertPromoted(response: Record<string, unknown>): void {
  rejectUnless(response, 'Promote', (error) => error === JOB_NOT_DELAYED_ERROR);
}

/** Progress: a job that is not active (or gone) is not updated; anything else throws. */
export function assertProgressUpdated(response: Record<string, unknown>): void {
  rejectUnless(
    response,
    'Progress',
    (error) => error === PROGRESS_JOB_NOT_FOUND_ERROR || error.startsWith(PROGRESS_NOT_ACTIVE_ERROR)
  );
}

/**
 * ChangeDelay from a Queue, job or flow object: a job that cannot be changed (gone,
 * active, finished) is not changed, as on 2.9.10; an invalid delay throws.
 */
export function assertDelayChanged(response: Record<string, unknown>): void {
  rejectUnless(response, 'ChangeDelay', (error) => error === DELAY_NOT_CHANGED_ERROR);
}

/** ClearLogs: every rejection (an invalid keepLogs) throws. */
export function assertLogsCleared(response: Record<string, unknown>): void {
  rejectUnless(response, 'ClearLogs');
}

/**
 * A processor's changeDelay of its own active job (Worker): not changing it throws the
 * broker's message, since the delivery must end there (2.9.10 threw too).
 */
export function requireDelayChanged(changed: boolean): void {
  if (!changed) throw new Error(DELAY_NOT_CHANGED_ERROR);
}

/** Embedded updateData: a job that cannot be updated throws the broker's message. */
export function requireDataUpdated(updated: boolean): void {
  if (!updated) throw new Error(DATA_NOT_UPDATED_ERROR);
}
