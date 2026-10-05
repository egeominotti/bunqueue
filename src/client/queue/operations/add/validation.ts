/**
 * Client-side job option validation for Queue.add/addBulk, in both modes.
 *
 * Embedded mode has no server in front of the engine, and in TCP mode an invalid add
 * that reached the auto-batcher would fail its whole PUSHB batch with a `jobs[i]:`
 * message. Validating here, with the broker's own validator, gives both modes the same
 * outcome before anything is sent or admitted, with messages that name the option as
 * the caller passed it (`attempts`, `deduplication.ttl`, `debounce.ttl`). The server
 * still validates every command it receives.
 */

import { CALLER_OPTION_NAMES, validateJobOptions } from '../../../../domain/job/options';
import type { JobOptions } from '../../../types';
import type { ExtendedJobOptions } from '../../types/add';
import { resolveGroupId } from './payload';

/** The first invalid bounded option of one add, under its SDK name, or null. */
export function addOptionsError(options: ExtendedJobOptions): string | null {
  return validateJobOptions(
    {
      groupId: resolveGroupId(options),
      priority: options.group?.priority ?? options.priority,
      groupMaxSize: options.group?.maxSize,
      delay: options.delay,
      timeout: options.timeout,
      maxAttempts: options.attempts,
      backoff: options.backoff,
      ttl: options.ttl,
      stallTimeout: options.stallTimeout,
      timestamp: options.timestamp,
      stackTraceLimit: options.stackTraceLimit,
      keepLogs: options.keepLogs,
      sizeLimit: options.sizeLimit,
      dedup: options.deduplication,
      debounceTtl: options.debounce?.ttl,
      repeat: options.repeat,
    },
    '',
    CALLER_OPTION_NAMES
  );
}

/** Throw the first invalid option of one add (queue defaults merged under `options`). */
export function assertAddOptions(defaults: JobOptions | undefined, options?: JobOptions): void {
  const error = addOptionsError({ ...defaults, ...options } as ExtendedJobOptions);
  if (error) throw new Error(error);
}

/** Throw `jobs[i]: <error>` for the first invalid job of a bulk add. */
export function assertBulkOptions(options: readonly ExtendedJobOptions[]): void {
  for (let index = 0; index < options.length; index++) {
    const error = addOptionsError(options[index]);
    if (error) throw new Error(`jobs[${index}]: ${error}`);
  }
}
