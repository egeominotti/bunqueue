/**
 * Durable side of an uncharged return to the queue.
 */

import type { Job } from '../../domain/types/job';
import type { SqliteStorage } from '../../infrastructure/persistence/sqlite';
import { queueLog } from '../../shared/logger';

/**
 * Store a job that went back to its queue without a charged attempt (a worker
 * disconnect release, a cancelled or failed pull handoff) in its queued state.
 * Without this write SQLite keeps the row `active` and startup recovery charges an
 * attempt the live broker never charged. Callers still hold the shard lock, so no pull
 * can claim the job before its row leaves `active`. A failed write is logged and leaves
 * the in-memory requeue in place (memory stays authoritative, as in pull finalization);
 * only a restart would then see the stale `active` row.
 */
export function persistRelease(job: Job, storage: SqliteStorage | null): void {
  try {
    storage?.markReleased(job);
  } catch (error) {
    queueLog.warn('Failed to persist released job', {
      jobId: String(job.id),
      queue: job.queue,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
