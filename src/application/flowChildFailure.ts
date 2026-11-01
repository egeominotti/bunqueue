/**
 * Flow child terminal failure - the policy a flow child carries
 * (`failParentOnFailure`, `continueParentOnFailure`, `ignoreDependencyOnFailure`,
 * `removeDependencyOnFailure`) applies whenever the child fails terminally, whether a
 * worker FAIL, an expired lock, stall detection or startup recovery exhausts it.
 */

import type { DlqEntry } from '../domain/types/dlq';
import type { FlowFailureMode, FlowFailureRecord } from '../domain/types/flow';
import type { Job, JobId } from '../domain/types/job';
import type { SqliteStorage } from '../infrastructure/persistence/sqlite';
import { queueLog } from '../shared/logger';

/** Applies a flow child's failure policy to its parent in memory. */
export interface FlowChildFailureCallbacks {
  onChildTerminalFailure?: (childJob: Job, error: string | undefined) => Promise<void>;
  onChildDependencyOption?: (childJob: Job, error: string | undefined) => Promise<void>;
}

/** The durable outbox record of a terminal child failure, or null without a policy. */
export function flowFailureRecord(job: Job, error: string | undefined): FlowFailureRecord | null {
  if (!job.parentId) return null;
  let mode: FlowFailureMode | null = null;
  if (job.failParentOnFailure) mode = 'fail';
  else if (job.continueParentOnFailure) mode = 'continue';
  else if (job.ignoreDependencyOnFailure) mode = 'ignore';
  else if (job.removeDependencyOnFailure) mode = 'remove';
  if (!mode) return null;
  return {
    parentId: job.parentId,
    childId: job.id,
    childQueue: job.queue,
    mode,
    error: error ?? 'unknown error',
    createdAt: Date.now(),
  };
}

/**
 * Persist a recovery path's move of an active job to the DLQ. Without a flow record
 * the writes are unchanged (DLQ entry, then the job rows). With one, the DLQ entry,
 * the outbox record and the job row commit in one transaction, as on a worker FAIL,
 * so a crash right after the move cannot lose the child's policy.
 */
export function persistRecoveryDlqMove(
  storage: SqliteStorage | null | undefined,
  jobId: JobId,
  entry: DlqEntry,
  flowFailure: FlowFailureRecord | null
): void {
  if (!storage) return;
  if (!flowFailure) {
    storage.saveDlqEntry(entry);
    storage.deleteJob(jobId);
    return;
  }
  storage.commitFailedJob(jobId, entry, flowFailure);
  // `deleteJob` also drops the outbox records of this job as a flow parent.
  storage.deleteFlowFailure(jobId);
}

/** Apply a terminally failed child's policy to its parent, as the worker FAIL path does. */
export async function applyChildFailurePolicy(
  job: Job,
  error: string | undefined,
  callbacks: FlowChildFailureCallbacks
): Promise<void> {
  if (job.failParentOnFailure && job.parentId && callbacks.onChildTerminalFailure) {
    await callbacks.onChildTerminalFailure(job, error);
  }
  if (
    job.parentId &&
    callbacks.onChildDependencyOption &&
    (job.removeDependencyOnFailure || job.ignoreDependencyOnFailure || job.continueParentOnFailure)
  ) {
    await callbacks.onChildDependencyOption(job, error);
  }
}

/**
 * Background variant: a policy that throws is logged instead of aborting the sweep.
 * The durable outbox record stays, so startup recovery applies it on the next start.
 */
export async function applyRecoveredChildFailurePolicy(
  job: Job,
  error: string,
  callbacks: FlowChildFailureCallbacks
): Promise<void> {
  try {
    await applyChildFailurePolicy(job, error, callbacks);
  } catch (err: unknown) {
    queueLog.error('Failed to apply flow child failure policy', {
      jobId: String(job.id),
      parentId: String(job.parentId),
      error: String(err),
    });
  }
}

/** The child-level `flow:failed` dashboard event the worker FAIL path emits. */
export function emitFlowChildFailed(
  emit: ((event: string, data: Record<string, unknown>) => void) | undefined,
  job: Job,
  error: string
): void {
  if (!job.parentId) return;
  emit?.('flow:failed', {
    parentJobId: String(job.parentId),
    failedChildId: String(job.id),
    queue: job.queue,
    error,
  });
}
