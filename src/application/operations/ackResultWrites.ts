/**
 * One SQLite transaction for a result-bearing batch ACK that reproduces the scalar
 * per-job storeResult()/markCompleted() loop exactly, including under failures.
 */
import { MAX_TIMELINE_ENTRIES, type JobId, type JobTimelineEntry } from '../../domain/types/job';
import type { SqliteStorage } from '../../infrastructure/persistence/sqlite';
import type { CompletionWrite } from '../../infrastructure/persistence/types/sqlite';
import type { ExtractedJob } from '../types/ack';

/** The two storage writes the batch ACK loop issues for a retained job. */
export interface CompletionWriter {
  storeResult(jobId: JobId, result: unknown): void;
  markCompleted(jobId: JobId, completedAt: number, timeline?: JobTimelineEntry[]): void;
}

/**
 * Commit the loop's writes up front (same statements and order, stopping where the
 * scalar loop would throw), then return a writer that settles each call in loop order
 * through the scalar safeWrite(): success, or the recorded error at the same call. The
 * loop, the job index, disk-full state and logs therefore end exactly as with scalar
 * writes. Returns null, writing nothing, when the scalar writes must run instead.
 */
export function batchedCompletionWriter<T>(
  extractedJobs: readonly ExtractedJob<T>[],
  storage: SqliteStorage,
  includeResults: boolean,
  now: number
): CompletionWriter | null {
  if (!includeResults || extractedJobs.length === 0) return null;
  const writes: CompletionWrite[] = [];
  for (const { id, job, result, removeOnComplete } of extractedJobs) {
    if (job.removeOnComplete || removeOnComplete === true) return null;
    if (result !== undefined) writes.push({ kind: 'result', jobId: id, result });
    writes.push({
      kind: 'complete',
      jobId: id,
      completedAt: now,
      timeline:
        job.timeline.length < MAX_TIMELINE_ENTRIES
          ? [...job.timeline, { state: 'completed', timestamp: now }]
          : job.timeline,
    });
  }
  if (writes.length === extractedJobs.length) return null;
  const outcome = storage.commitCompletionWrites(writes);
  if (outcome === undefined) return null;
  let call = 0;
  const settle = (): void => {
    storage.settleCompletionWrite(outcome?.failedAt === call++ ? outcome : null);
  };
  return { storeResult: settle, markCompleted: settle };
}
