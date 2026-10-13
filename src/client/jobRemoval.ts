/**
 * `job.remove()` and `queue.removeAsync()` in both modes (issue #155).
 *
 * The broker's Cancel removes a pending or a completed job. The awaited remove resolves
 * when the job was removed or does not exist (idempotent cleanup, as in BullMQ) and
 * rejects when the job exists in a state Cancel does not remove (an active or a failed
 * job), so a caller never believes a job is gone while it still holds its data.
 * The fire-and-forget `queue.remove()` keeps its background reporting unchanged.
 * See docs/features/client-queue-sdk.md ("remove / removeAsync").
 */

import { cancelWithOutcome } from '../domain/job/cancellation';
import { jobId } from '../domain/types/job';
import { getSharedManager } from './manager';

interface CancelTransport {
  send(command: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * The TCP `Cancel` reply as a removal: `ok`, or a rejection saying "not found" (a
 * missing job, also the ambiguous reply of a broker older than this rule), resolves;
 * any other rejection (`Job cannot be cancelled (current state: active)`, an
 * authentication or validation error) throws the broker's message.
 */
export function assertCancelReply(response: Record<string, unknown>): void {
  if (response.ok !== false) return;
  const error =
    typeof response.error === 'string' && response.error.length > 0
      ? response.error
      : 'Cancel failed';
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
    throw new Error(`Job ${id} cannot be removed (current state: ${outcome.state})`);
  }
  if (!tcp) return;
  assertCancelReply(await tcp.send({ cmd: 'Cancel', id }));
}
