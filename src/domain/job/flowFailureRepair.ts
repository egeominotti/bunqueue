/**
 * Repair rule for flow parents that older versions left in `waiting-children`.
 *
 * Before the flow-failure outbox fixes, a flow child carrying a failure policy that
 * startup recovery, lock expiry or stall detection exhausted, and a parent failed by a
 * child's `failParentOnFailure`, could reach the DLQ without the outbox record that
 * applies the policy to its parent. The parent kept its dependency edge on a terminally
 * failed child and waited forever. Startup synthesizes the missing record (SQLite and
 * PostgreSQL alike) when, and only when, the current version would already have
 * written it at that terminal failure; the regular outbox replay then applies it.
 */

import { FailureReason } from '../types/dlq';
import { FAILED_BY_CHILD_PREFIX } from './flowFailureMessage';
import type { FlowFailureMode, FlowFailureRecord } from '../types/flow';
import type { Job } from '../types/job';

/** A terminally failed child as stored with its DLQ entry. */
export interface TerminalFlowChild {
  /** The child job as stored when it entered the DLQ. */
  readonly job: Job;
  /** The DLQ entry's failure reason; null or unknown values are never repaired. */
  readonly reason: string | null | undefined;
  /** The DLQ entry's error message. */
  readonly error: string | null | undefined;
  /** When the terminal failure happened (the DLQ entry's last attempt). */
  readonly failedAt: number;
}

/** The mode of a flow child's failure policy, in the precedence the FAIL path uses. */
export function flowFailurePolicyMode(job: Job): FlowFailureMode | null {
  if (!job.parentId) return null;
  if (job.failParentOnFailure) return 'fail';
  if (job.continueParentOnFailure) return 'continue';
  if (job.ignoreDependencyOnFailure) return 'ignore';
  if (job.removeDependencyOnFailure) return 'remove';
  return null;
}

/**
 * Whether the parent sat in `waiting-children` from the child's terminal failure until
 * now, as a parent that an older version stranded does. Anything else means the
 * failure was never eligible, or someone already acted on the parent after it:
 * - its last transition before the failure is `active`: it was running then, and no
 *   version applies a policy to a running parent;
 * - any transition at or after the failure other than `waiting-children` (linking a new
 *   child to a waiting parent records only that one): a DLQ retry (`waiting`), a run
 *   (`active`), a promotion, or its own failure;
 * - `lastHeartbeat` at or after the failure: a pull and a DLQ retry both stamp it, so
 *   this still holds when the timeline is full (`MAX_TIMELINE_ENTRIES`) and recorded
 *   neither. A full timeline can still hide a run that ended in `moveToWaitingChildren`
 *   without a heartbeat after the failure; such a parent is repaired.
 * Equal timestamps count as "after", so a same-millisecond tie is never repaired.
 */
function stayedWaitingSince(parent: Job, failedAt: number): boolean {
  if ((parent.lastHeartbeat ?? 0) >= failedAt) return false;
  let before: { state: string; timestamp: number } | null = null;
  for (const entry of parent.timeline) {
    if (entry.timestamp >= failedAt) {
      if (entry.state !== 'waiting-children') return false;
    } else if (!before || entry.timestamp >= before.timestamp) {
      before = entry;
    }
  }
  return before?.state !== 'active';
}

/**
 * The record a terminal failure of `child` should have left for `parent`, or null when
 * nothing must be repaired. The caller guarantees that `parent` is waiting for its
 * children, that the child is currently in the DLQ and that no record exists yet.
 *
 * - The child must still be linked to this parent and the parent must still depend on it.
 * - The child must carry a policy: without one the parent keeps waiting (the default).
 * - A discard moves a job to the DLQ with reason `unknown` and no error and never
 *   applies a policy, so only `unknown` entries of parents failed by a child qualify.
 * - The parent must have stayed waiting since the failure (`stayedWaitingSince`): a
 *   parent retried from the DLQ, run, promoted or running at the failure is left alone.
 */
export function missingFlowFailureRecord(
  parent: Job,
  child: TerminalFlowChild
): FlowFailureRecord | null {
  const job = child.job;
  if (!job.parentId || String(job.parentId) !== String(parent.id)) return null;
  if (!parent.dependsOn.some((id) => String(id) === String(job.id))) return null;
  const mode = flowFailurePolicyMode(job);
  if (!mode) return null;
  if (!child.reason) return null;
  if (child.reason === FailureReason.Unknown && !child.error?.startsWith(FAILED_BY_CHILD_PREFIX)) {
    return null;
  }
  if (!stayedWaitingSince(parent, child.failedAt)) return null;
  return {
    parentId: parent.id,
    childId: job.id,
    childQueue: job.queue,
    mode,
    error: child.error ?? 'unknown error',
    createdAt: child.failedAt,
  };
}
