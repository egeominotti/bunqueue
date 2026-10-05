/**
 * The per-job processing-timeout rule, shared by the broker and the Worker.
 *
 * The broker is the timeout authority: its scheduler (`application/background/
 * timeouts.ts`) fails a job with `FailureReason.Timeout` at `processingDeadline(job)`.
 * The Worker (`client/worker/runtime/`) only aborts the processor signal after
 * `processingTimeoutDelay(job)` and then abandons that delivery's late outcome. That
 * is safe only while both read the stored `timeout` the same way: a Worker timer the
 * broker does not enforce would leave the job `active` with nothing to settle it. So
 * both import this module, and nothing else interprets `job.timeout`.
 *
 * Producers accept 0..24 h, but the broker stores whatever it is given (a direct
 * `QueueManager.push`, an older release, another client), so every value is handled.
 */
import type { Job } from '../types/jobs/model';

/** The deadline meaning "never": beyond any real one, yet still ordered in a min-heap. */
export const NEVER_DEADLINE = Number.MAX_SAFE_INTEGER;

/**
 * The absolute processing deadline (epoch ms) of a started job, or null for no timeout.
 *
 * - an absent, `0` or `NaN` timeout is no timeout;
 * - the deadline is `Math.ceil(startedAt + timeout)`: a fraction is rounded up, so it is
 *   never early, and a negative timeout is already due;
 * - a deadline that is still not a safe integer (`±Infinity`, an overflow) is
 *   `NEVER_DEADLINE`.
 */
export function processingDeadline(job: Pick<Job, 'timeout' | 'startedAt'>): number | null {
  const { timeout, startedAt } = job;
  if (!timeout || startedAt === null) return null;
  const deadline = Math.ceil(startedAt + timeout);
  return Number.isSafeInteger(deadline) ? deadline : NEVER_DEADLINE;
}

/**
 * The Worker's abort delay: the distance from `startedAt` to `processingDeadline(job)`,
 * or null when the broker enforces no reachable deadline (none, or `NEVER_DEADLINE`).
 *
 * The Worker arms it when it starts the job, never before `startedAt`, so its abort
 * never precedes the broker's deadline. A negative delay fires on the next tick and one
 * above the native timer limit is honoured by `safeTimeout`.
 *
 * Hot path (once per job start): a few comparisons and additions, no allocation.
 */
export function processingTimeoutDelay(job: Pick<Job, 'timeout' | 'startedAt'>): number | null {
  const deadline = processingDeadline(job);
  if (deadline === null || deadline === NEVER_DEADLINE) return null;
  return deadline - (job.startedAt as number);
}
