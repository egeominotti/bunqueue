/**
 * Arguments of the job setters that reach ordering or storage: ChangePriority, Progress,
 * Update and ClearLogs. The engine (`QueueManager.changePriority/updateProgress/
 * updateJobData/clearLogs`, the PostgreSQL engine) and the TCP handlers converge on
 * these, so every caller (embedded, TCP, HTTP, MCP, Cloud, a 2.9.10 client) gets the
 * same result: 2.9.10's wherever it was well defined.
 */

import { coerceNumericString } from './optionBounds';

/** The 10 MB job-data limit of PUSH, PUSHB and flows. */
export const MAX_JOB_DATA_CHARS = 10 * 1024 * 1024;

/** Job data must be JSON serializable and at most 10 MB serialized (the PUSH rule). */
export function validateJobData(data: unknown): string | null {
  let json: string | undefined;
  try {
    json = JSON.stringify(data);
  } catch {
    return 'Job data must be JSON serializable';
  }
  if (json !== undefined && json.length > MAX_JOB_DATA_CHARS) {
    return 'Job data too large (max 10MB)';
  }
  return null;
}

/**
 * Update data: JSON serializable, with no size limit, as on 2.9.10 in both modes (an
 * `updateData` of 11 MB succeeded; refusing it now would fail a working processor).
 */
export function validateUpdatedJobData(data: unknown): string | null {
  try {
    JSON.stringify(data);
    return null;
  } catch {
    return 'Job data must be JSON serializable';
  }
}

/**
 * ChangePriority `priority`: any finite number (a numeric string is its number), for
 * grouped jobs too, as 2.9.10 applied it in both modes; the heap comparators order any
 * finite number. A missing priority (`changePriority({ lifo: true })`) is 0, as BullMQ
 * and 2.9.10 over TCP applied it. NaN or an infinity broke the order (`Infinity -
 * Infinity` is NaN) and is refused.
 */
export function validatePriorityChange(priority: unknown): string | null {
  if (priority === undefined || priority === null) return null;
  const value = coerceNumericString(priority);
  if (typeof value !== 'number') return 'priority must be a number';
  return Number.isFinite(value) ? null : 'priority must be a finite number';
}

/**
 * The change a ChangePriority applies; throws the `validatePriorityChange` error. `lifo`
 * is a boolean exactly as on PUSH (`1` is true, `0` is false), since a non-boolean
 * `lifo` made two jobs each sort before the other; undefined/null keep the job's own.
 */
export function priorityChange(
  priority: unknown,
  lifo: unknown
): { priority: number; lifo: boolean | undefined } {
  const error = validatePriorityChange(priority);
  if (error) throw new Error(error);
  return {
    priority:
      priority === undefined || priority === null ? 0 : (coerceNumericString(priority) as number),
    lifo: lifo === undefined || lifo === null ? undefined : Boolean(lifo),
  };
}

/**
 * The broker's reply when ChangePriority finds no queued job (missing, active or
 * finished). Clients treat it as "not changed", as embedded mode ignores a false result;
 * any other rejection (an invalid priority or lifo) throws.
 */
export const PRIORITY_NOT_CHANGED_ERROR = 'Job not found or not in queue';

/**
 * The broker's replies when a setter finds no job it can apply to. Clients report them
 * as 2.9.10 did (see docs/features/job-options-validation.md):
 * - `changeDelay`, `promote`, progress and ChangePriority resolve without change: they
 *   race with normal processing (the job matures, is pulled or finishes);
 * - `updateData` throws: the new data would be lost silently.
 */
export const DELAY_NOT_CHANGED_ERROR = 'Job not found or cannot change delay';
export const DATA_NOT_UPDATED_ERROR = 'Job not found or cannot be updated';
export const JOB_NOT_DELAYED_ERROR = 'Job not found or not delayed';
export const PROGRESS_JOB_NOT_FOUND_ERROR = 'Job not found';
/** Followed by ` (current state: <state>)`. */
export const PROGRESS_NOT_ACTIVE_ERROR = 'Job is not active';

/**
 * The stored form of a progress update. It never throws, so a processor's
 * `updateProgress` cannot fail its job (2.9.10 completed it):
 * - a number is kept (the engine clamps it to [0, 100]); NaN is 0;
 * - an object (BullMQ object progress) is 0 with its JSON as the message;
 * - a numeric string, a boolean and null are `Number(value)`, as 2.9.10 stored them
 *   (`'50'` is 50, `true` is 1, `null` is 0);
 * - any other string (`'downloading'`) is 0 with the text as the message, unless a
 *   message was given; any other value is 0.
 * 2.9.10 stored NaN for the last two, which serialized as null.
 */
export function normalizeProgress(
  progress: unknown,
  message?: string
): { progress: number; message?: string } {
  if (typeof progress === 'number') {
    return { progress: progress === progress ? progress : 0, message };
  }
  if (typeof progress === 'object' && progress !== null) {
    return { progress: 0, message: message ?? progressJson(progress) };
  }
  if (typeof progress === 'boolean' || progress === null) {
    return { progress: Number(progress), message };
  }
  if (typeof progress === 'string') {
    const number = Number(progress); // '' is 0, as 2.9.10 stored it
    if (number === number) return { progress: number, message };
    return { progress: 0, message: message ?? progress };
  }
  return { progress: 0, message };
}

/** An object progress as its JSON message; one JSON cannot encode has no message. */
function progressJson(progress: object): string | undefined {
  try {
    return JSON.stringify(progress);
  } catch {
    return undefined;
  }
}

/**
 * ClearLogs `keepLogs`, as 2.9.10 applied it: undefined/null clear every entry, a value
 * of 0 or less clears every entry, a fraction keeps its whole part (`1.5` keeps 1), a
 * numeric string is its number and a value above the entry count keeps them all. NaN
 * and non-numbers are refused (2.9.10 silently kept every entry).
 */
export function validateKeepLogs(keepLogs: unknown): string | null {
  if (keepLogs === undefined || keepLogs === null) return null;
  const value = coerceNumericString(keepLogs);
  return typeof value === 'number' && value === value ? null : 'keepLogs must be a number';
}

/** The entry count ClearLogs keeps (0 clears all), or undefined; throws for NaN. */
export function keepLogsArgument(keepLogs: unknown): number | undefined {
  const error = validateKeepLogs(keepLogs);
  if (error) throw new Error(error);
  if (keepLogs === undefined || keepLogs === null) return undefined;
  const value = coerceNumericString(keepLogs) as number;
  // Infinity keeps every entry, as any count above the entries does (a SQL LIMIT needs a number).
  return value > 0 ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER) : 0;
}
