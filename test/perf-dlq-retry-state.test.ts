/**
 * DLQ retry state is cleared by assigning `undefined` to its hidden property
 * instead of deleting it: retried jobs that complete or enter the DLQ keep a
 * shared hidden class (Structure) instead of one each.
 */
import { describe, expect, test } from 'bun:test';
import { heapStats } from 'bun:jsc';
import {
  createDlqEntry,
  FailureReason,
  getDlqRetryState,
  recordJobFailureAttempt,
} from '../src/domain/types/dlq';
import { createJob, jobId } from '../src/domain/types/job';
import { pack } from '../src/infrastructure/persistence/sqliteSerializer';

describe('DLQ retry state clearing', () => {
  test("keeps attempt history and leaves the job's enumerable shape unchanged", () => {
    const job = createJob(jobId('retry-shape'), 'q', { data: { a: 1 } });
    const keysBefore = Object.keys(job);
    job.attempts = 1;
    recordJobFailureAttempt(job, FailureReason.ExplicitFail, 'first', 1);
    expect(Object.keys(job)).toEqual(keysBefore);
    expect(getDlqRetryState(job)?.attempts).toHaveLength(1);

    job.attempts = 2;
    const entry = createDlqEntry(job, FailureReason.ExplicitFail, 'second');
    expect(entry.attempts.map((attempt) => attempt.error)).toEqual(['first', 'second']);
    expect(getDlqRetryState(job)).toBeNull();
    expect(Object.keys(job)).toEqual(keysBefore);
  });

  test('retried jobs entering the DLQ share one hidden class', () => {
    const count = 2_000;
    const entries: unknown[] = [];
    Bun.gc(true);
    const before = heapStats().objectTypeCounts.Structure ?? 0;
    // Guard: the counter exists, so a missing counter cannot pass vacuously.
    expect(before).toBeGreaterThan(0);
    for (let index = 0; index < count; index++) {
      const job = createJob(jobId(`shape-${index}`), 'q', { data: { index } });
      job.attempts = 1;
      recordJobFailureAttempt(job, FailureReason.ExplicitFail, 'boom', 1);
      job.attempts = 2;
      const entry = createDlqEntry(job, FailureReason.ExplicitFail, 'boom');
      pack(entry);
      entries.push(entry);
    }
    Bun.gc(true);
    const grown = (heapStats().objectTypeCounts.Structure ?? 0) - before;
    expect(entries).toHaveLength(count);
    // Before the clearing this grew by one Structure per entry (~2,000).
    expect(grown).toBeLessThan(count / 10);
  });
});
