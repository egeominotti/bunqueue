import { expect } from 'bun:test';
import type { QueueManager } from '../../src/application/queueManager';
import type { JobId } from '../../src/domain/types/job';

export function raceTraceJson(value: unknown): string {
  return JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? String(item) : item));
}

const states = [
  ['waiting', 'waiting'],
  ['prioritized', 'prioritized'],
  ['delayed', 'delayed'],
  ['active', 'active'],
  ['completed', 'completed'],
  ['failed', 'dlq'],
  ['waiting-children', 'waiting-children'],
] as const;

/** Compare independent public listings and counters, retaining every original ID exactly once. */
export function assertRaceConservation(manager: QueueManager, queue: string, ids: JobId[]) {
  // A retry can become due between synchronous reads. Repeat only if this snapshot
  // crossed a runAt boundary; never retry a count/ID assertion failure.
  for (let attempt = 0; attempt < 100; attempt++) {
    const started = Date.now();
    // A crossing retry can be absent from both the earlier waiting read and
    // the later delayed read, so deadlines must come from an unfiltered read.
    const deadlines = manager.getJobs(queue, { end: ids.length + 1 }).map((job) => job.runAt);
    const buckets = states.map(([state, counter]) => ({
      state,
      counter,
      jobs: manager.getJobs(queue, { state, end: ids.length + 1 }),
    }));
    const stats = manager.getStats();
    const ended = Date.now();
    if (deadlines.some((runAt) => runAt > started && runAt <= ended)) {
      continue;
    }
    const membership = buckets.map(({ state, jobs }) => ({
      state,
      ids: jobs.map((job) => job.id),
    }));
    try {
      const retained = buckets.flatMap(({ jobs }) => jobs.map((job) => job.id));
      expect(new Set(ids).size).toBe(ids.length);
      expect(retained).toHaveLength(ids.length);
      expect(new Set(retained).size).toBe(ids.length);
      expect(new Set(retained)).toEqual(new Set(ids));
      for (const { counter, jobs } of buckets) expect(stats[counter]).toBe(jobs.length);
      expect(states.reduce((sum, [, counter]) => sum + stats[counter], 0)).toBe(ids.length);
      return { stats, membership };
    } catch (cause) {
      throw new Error(`Job conservation failed: ${raceTraceJson({ stats, membership, ids })}`, {
        cause,
      });
    }
  }
  throw new Error('Could not capture a stable job-state snapshot');
}

export type ChaosAction = 'pull' | 'ack' | 'fail';

/** Test-owned xorshift32: never changes runtime backoff jitter or global Math.random. */
export function chaosActions(seed: number): ChaosAction[] {
  let value = seed | 0;
  return Array.from({ length: 200 }, () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (['pull', 'ack', 'fail'] as const)[(value >>> 0) % 3];
  });
}

export async function runChaos(manager: QueueManager, queue: string, actions: ChaosAction[]) {
  const started = performance.now();
  const trace = actions.map((action, index) => ({
    index,
    action,
    startMs: 0,
    endMs: 0,
    id: null as JobId | null,
    outcome: 'pending',
    attempts: null as number | null,
    runAt: null as number | null,
  }));
  const results = await Promise.allSettled(
    trace.map(async (entry) => {
      entry.startMs = performance.now() - started;
      try {
        const job = await manager.pull(queue, entry.action === 'pull' ? 5 : 0);
        if (!job) {
          entry.outcome = 'empty';
          return;
        }
        entry.id = job.id;
        if (entry.action === 'ack') expect(await manager.ack(job.id, {})).toBeUndefined();
        if (entry.action === 'fail') expect(await manager.fail(job.id, 'chaos')).toBeUndefined();
        entry.outcome = await manager.getJobState(job.id);
        if (entry.action === 'ack') expect(entry.outcome).toBe('completed');
        const retained = await manager.getJob(job.id);
        entry.attempts = retained?.attempts ?? null;
        entry.runAt = retained?.runAt ?? null;
      } catch (error) {
        entry.outcome = String(error);
        throw error;
      } finally {
        entry.endMs = performance.now() - started;
      }
    })
  );
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) {
    throw new AggregateError(
      failures.map((result) => result.reason),
      JSON.stringify(trace)
    );
  }
  return trace;
}
