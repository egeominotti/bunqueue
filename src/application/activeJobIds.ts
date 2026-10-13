/**
 * Active Job Ids - the authoritative active set of one queue.
 *
 * A queue concurrency limiter created while jobs of the queue are already
 * active is seeded from this set, so those jobs count toward the new limit
 * (BullMQ counts the whole active list toward global concurrency).
 */

import type { Job, JobId } from '../domain/types/job';
import type { JobLocation } from '../domain/types/queue';

/**
 * Ids of the jobs of `queue` that are active right now: present in a
 * processing shard and indexed as `processing`. A job that a failed handoff
 * has already put back in the queue (indexed `queue`, its processing entry not
 * yet removed) released its slot and is not active. A job whose completion has
 * removed it from processing has not yet released its slot, but its release is
 * then a no-op on the new limiter, so the count stays exact either way.
 *
 * Linear in the number of processing jobs; called only when a limiter is
 * created (set after none, or after a clear), never on the pull/ack path.
 */
export function activeJobIdsOf(
  queue: string,
  processingShards: readonly Map<JobId, Job>[],
  jobIndex: ReadonlyMap<JobId, JobLocation>
): JobId[] {
  const ids: JobId[] = [];
  for (const processing of processingShards) {
    for (const [id, job] of processing) {
      if (job.queue === queue && jobIndex.get(id)?.type === 'processing') ids.push(id);
    }
  }
  return ids;
}
