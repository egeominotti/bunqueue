/**
 * Cleanup shared ownership state when a management operation claims an active
 * job before its worker can ACK or FAIL it.
 */

import type { JobId, JobLock } from '../../domain/types/job';
import { detachClientJob, type ClientOwnershipMaps } from '../clientOwnership';

export interface JobClaimContext extends ClientOwnershipMaps {
  jobLocks: Map<JobId, JobLock>;
}

/**
 * Release the live lease and detach the job from its TCP client owner.
 *
 * Map/Set deletion is intentionally idempotent: management commands can race
 * with disconnect cleanup, but ownership must be removed exactly once from the
 * observable state.
 */
export function releaseClaimedJobOwnership(jobId: JobId, ctx: JobClaimContext): void {
  ctx.jobLocks.delete(jobId);
  detachClientJob(jobId, ctx);
}
