/**
 * The outcome of a `Cancel` (`job.remove()`, `queue.removeAsync()`, `DELETE /jobs/:id`).
 *
 * Cancel removes a pending job (waiting, delayed, prioritized, waiting-children) and a
 * completed one; an active or failed job is never removed by it, and PostgreSQL also
 * refuses a pending job that a live job depends on (the reply names its pending state).
 * When nothing was removed, the caller learns why from the job's state:
 * - `unknown`: the job does not exist, the legacy reply `CANCEL_JOB_NOT_FOUND_ERROR`
 *   (external SDKs match its "not found"), and clients resolve, as BullMQ does;
 * - any other state: `cancelRefusedError(state)`, and clients reject.
 * See docs/features/job-lifecycle.md ("Removing a job").
 */
import type { JobId } from '../types/job';

/** The reply for a job that does not exist (kept verbatim for external SDKs). */
export const CANCEL_JOB_NOT_FOUND_ERROR = 'Job not found or cannot be cancelled';

/** The reply for an existing job that Cancel does not remove. */
export function cancelRefusedError(state: string): string {
  return `Job cannot be cancelled (current state: ${state})`;
}

/** States Cancel removes; any other existing state refuses it. */
const REMOVABLE_STATES: ReadonlySet<string> = new Set([
  'waiting',
  'delayed',
  'prioritized',
  'waiting-children',
  'completed',
]);

/**
 * A refused Cancel is retried only when the job moved into a removable state between the
 * refusal and the state read (an active job completed, for instance), so the reply never
 * names a state that no longer refuses it. A refusal is retried when the state read after
 * it is removable and differs from the state read after the previous refusal: a stable
 * refusal of a removable state (a PostgreSQL waiting producer that a live job depends on)
 * stops after two attempts, a non-removable one after the first, and the number of
 * attempts never exceeds this bound.
 */
export const MAX_CANCEL_ATTEMPTS = 3;

/** The two engine reads a cancellation needs; both engines and the server provide them. */
export interface CancelPort {
  cancel(id: JobId): Promise<boolean>;
  getJobState(id: JobId): Promise<string>;
}

export type CancelOutcome =
  | { readonly removed: true }
  | { readonly removed: false; readonly state: string };

/**
 * Cancel `id`; when nothing was removed, also report the state that explains why. Every
 * attempt targets the job ID, so a retry removes whatever generation holds the ID by
 * then, exactly as a Cancel sent a moment later would.
 */
export async function cancelWithOutcome(port: CancelPort, id: JobId): Promise<CancelOutcome> {
  let previous: string | null = null;
  for (let attempt = 1; ; attempt++) {
    if (await port.cancel(id)) return { removed: true };
    const state = await port.getJobState(id);
    const moved = REMOVABLE_STATES.has(state) && state !== previous;
    if (!moved || attempt >= MAX_CANCEL_ATTEMPTS) return { removed: false, state };
    previous = state;
  }
}
