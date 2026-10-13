/**
 * `job.remove()` and `queue.removeAsync()` in both modes (issue #155).
 *
 * The broker's Cancel removes a pending or a completed job. The awaited remove resolves
 * when the job was removed or does not exist (idempotent cleanup, as in BullMQ) and
 * rejects when the job exists in a state Cancel does not remove (an active or a failed
 * job), so a caller never believes a job is gone while it still holds its data.
 * The fire-and-forget `queue.remove()` keeps its background reporting unchanged.
 *
 * Mixed versions: this broker sends the legacy `Job not found or cannot be cancelled`
 * only for a missing job, but a broker older than this rule (2.9.13 and earlier) sends
 * it for every refusal, an active, a failed or a completed job included. That reply is
 * therefore never taken as "missing" on its own: the job's state is read over the same
 * transport (`GetState`) and only `unknown` resolves.
 * See docs/features/client-queue-sdk.md ("remove / removeAsync").
 */

import { CANCEL_JOB_NOT_FOUND_ERROR, cancelWithOutcome } from '../domain/job/cancellation';
import { jobId } from '../domain/types/job';
import { getSharedManager } from './manager';

interface CancelTransport {
  send(command: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** The rejection of a remove that left an existing job in place, in both modes. */
function removalRefused(id: string, state: string): Error {
  return new Error(`Job ${id} cannot be removed (current state: ${state})`);
}

/** The `error` of an `ok: false` reply, or `fallback`. */
function replyError(response: Record<string, unknown>, fallback: string): string {
  return typeof response.error === 'string' && response.error.length > 0
    ? response.error
    : fallback;
}

/**
 * After the legacy ambiguous refusal: resolves only when the broker reads the job as
 * `unknown`. Any other state rejects naming it; a state that cannot be read rejects with
 * the GetState error, or with the refusal itself (what 2.9.13 clients did).
 */
async function assertMissingAfterLegacyRefusal(
  tcp: CancelTransport,
  id: string,
  refusal: string
): Promise<void> {
  const response = await tcp.send({ cmd: 'GetState', id });
  if (response.ok === false) throw new Error(replyError(response, refusal));
  const state = response.state;
  if (state === 'unknown') return;
  if (typeof state !== 'string' || state.length === 0) throw new Error(refusal);
  throw removalRefused(id, state);
}

/**
 * The TCP `Cancel` reply for job `id` as a removal: `ok` resolves. The legacy ambiguous
 * reply resolves only when a state read finds no such job (see the module comment); any
 * other rejection saying "not found" resolves; any other rejection (`Job cannot be
 * cancelled: not in queue (current state: active)`, an authentication or validation
 * error) throws the broker's message.
 */
export async function assertCancelReply(
  tcp: CancelTransport,
  id: string,
  response: Record<string, unknown>
): Promise<void> {
  if (response.ok !== false) return;
  const error = replyError(response, 'Cancel failed');
  if (error === CANCEL_JOB_NOT_FOUND_ERROR) {
    await assertMissingAfterLegacyRefusal(tcp, id, error);
    return;
  }
  if (/not found/i.test(error)) return;
  throw new Error(error);
}

/** Remove a job, embedded or over TCP; see the module comment for the outcome rule. */
export async function removeJob(
  embedded: boolean,
  tcp: CancelTransport | null,
  id: string
): Promise<void> {
  if (embedded) {
    const outcome = await cancelWithOutcome(getSharedManager(), jobId(id));
    if (outcome.removed || outcome.state === 'unknown') return;
    throw removalRefused(id, outcome.state);
  }
  if (!tcp) return;
  await assertCancelReply(tcp, id, await tcp.send({ cmd: 'Cancel', id }));
}
