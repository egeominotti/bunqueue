/**
 * Repro: two engine entry points read job durations differently from the rest of bunqueue.
 *
 * - `isTimedOut` (public through the job facade) treated `timeout: 0` as already timed
 *   out, and a NaN timeout as never, with a strict `>` boundary, while the broker's
 *   timeout scheduler and the Worker share `processingDeadline` (0 and NaN mean no
 *   timeout, a fraction rounds up, the deadline itself is due).
 * - `QueueManager.pull`, `pullWithLock`, `pullBatch` and `pullBatchWithLock` accepted any
 *   `timeoutMs`. 2.9.10 never refused nor capped a direct call, so any wait is honoured
 *   (Infinity until a job arrives or the signal aborts) and NaN or a negative value still
 *   means "do not wait", as on 2.9.10; TCP PULL/PULLB keep their 0..60000 bound.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { createJob, isTimedOut, jobId, type Job } from '../src/domain/types/job';
import { processingDeadline } from '../src/domain/job/timeoutRule';
import { pullTimeoutArgument } from '../src/domain/job/options';

let manager: QueueManager | null = null;

afterEach(() => {
  manager?.shutdown();
  manager = null;
});

function started(timeout: number | null, startedAt = 1_000): Job {
  return { ...createJob(jobId('timeout-rule'), 'q', { data: {} }), timeout, startedAt };
}

describe('isTimedOut follows the shared processing-timeout rule', () => {
  test('0 and NaN mean no timeout, as for the scheduler and the Worker', () => {
    expect(isTimedOut(started(0), 1_000_000)).toBe(false);
    expect(isTimedOut(started(Number.NaN), 1_000_000)).toBe(false);
    expect(isTimedOut(started(Infinity), Number.MAX_SAFE_INTEGER - 1)).toBe(false);
  });

  test('the deadline is due at processingDeadline, fractions rounded up', () => {
    for (const [timeout, now] of [
      [5_000, 6_000],
      [0.5, 1_001],
      [1.5, 1_002],
    ] as const) {
      const job = started(timeout);
      expect(processingDeadline(job)).toBe(now);
      expect([isTimedOut(job, now - 1), isTimedOut(job, now)]).toEqual([false, true]);
    }
  });
});

describe('QueueManager pull timeouts keep their 2.9.10 meaning', () => {
  test('NaN and negative mean no wait; Infinity and long waits are honoured', async () => {
    manager = new QueueManager();
    const qm = manager;
    const outcomes: string[] = [];
    for (const timeout of [Number.NaN, -1, Infinity, 60_001]) {
      for (const [label, call] of [
        ['pull', (signal: AbortSignal) => qm.pull('pull-timeout', timeout, signal)],
        [
          'pullWithLock',
          (signal: AbortSignal) => qm.pullWithLock('pull-timeout', 'w1', timeout, 30_000, signal),
        ],
        ['pullBatch', (signal: AbortSignal) => qm.pullBatch('pull-timeout', 1, timeout, signal)],
        [
          'pullBatchWithLock',
          (signal: AbortSignal) =>
            qm.pullBatchWithLock('pull-timeout', 1, 'w1', timeout, 30_000, signal),
        ],
      ] as const) {
        const controller = new AbortController();
        const outcome = await Promise.race([
          call(controller.signal).then(
            () => '<resolved>',
            (error: unknown) => (error instanceof Error ? error.message : String(error))
          ),
          Bun.sleep(200).then(() => '<still waiting>'),
        ]);
        controller.abort();
        outcomes.push(`${label}(${String(timeout)}): ${outcome}`);
      }
    }
    const expected = (timeout: number, outcome: string) =>
      ['pull', 'pullWithLock', 'pullBatch', 'pullBatchWithLock'].map(
        (label) => `${label}(${String(timeout)}): ${outcome}`
      );
    expect(outcomes).toEqual([
      ...expected(Number.NaN, '<resolved>'),
      ...expected(-1, '<resolved>'),
      ...expected(Infinity, '<still waiting>'),
      ...expected(60_001, '<still waiting>'),
    ]);
    // Not capped at the TCP PULL bound (2.9.10 honoured them; repro-compat-job-past-run-time).
    expect([Infinity, 60_001, 120_000].map(pullTimeoutArgument)).toEqual([
      Infinity,
      60_001,
      120_000,
    ]);
  });

  test('valid timeouts still work: 0 returns at once and the default is 0', async () => {
    manager = new QueueManager();
    expect(await manager.pull('pull-timeout-valid', 0)).toBeNull();
    expect(await manager.pull('pull-timeout-valid')).toBeNull();
    await manager.push('pull-timeout-valid', { data: {} });
    expect(await manager.pullBatch('pull-timeout-valid', 1, 60_000)).toHaveLength(1);
  });
});
