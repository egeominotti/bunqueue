/**
 * REPRO — Job processing timeout: a fractional `timeout` never times out on the server.
 *
 * Run: bun test test/repro-job-timeout-fractional.test.ts
 *
 * `deadlineFor` (src/application/background/timeouts.ts) maps a deadline that is not a
 * safe integer to `Number.MAX_SAFE_INTEGER` ("never"), meant for a deadline too large
 * to represent. `startedAt + 1.5` is not an integer, so a job with a fractional
 * timeout stayed active forever. TCP validation accepts fractional timeouts and
 * persisted jobs may already carry them.
 *
 * Asserts: a fractional timeout is honoured, rounded up to the next whole millisecond
 * (never early); 0 and NaN still mean no timeout.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import type { JobId } from '../src/domain/types/job';

let manager: QueueManager | null = null;

afterEach(() => {
  manager?.shutdown();
  manager = null;
});

function pendingTimeouts(value: QueueManager): number {
  return (value as unknown as { timeoutScheduler: { pendingCount: number } }).timeoutScheduler
    .pendingCount;
}

async function stateAfter(id: JobId, state: string, timeoutMs = 2_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await manager!.getJobState(id);
    if (current === state) return current;
    await Bun.sleep(5);
  }
  return manager!.getJobState(id);
}

describe('REPRO: fractional job processing timeouts', () => {
  test.each([0.4, 1.5, 25.25])('a %p ms timeout fails the active job', async (timeout) => {
    manager = new QueueManager();
    const job = await manager.push('fractional-timeout', { data: {}, maxAttempts: 1, timeout });
    const pulled = await manager.pull('fractional-timeout');
    expect(pulled?.id).toBe(job.id);
    expect(await stateAfter(job.id, 'failed')).toBe('failed');
    expect(pendingTimeouts(manager)).toBe(0);
  });

  test('a fractional timeout is not honoured early: 300.5 ms is still active at 200 ms', async () => {
    manager = new QueueManager();
    const job = await manager.push('fractional-timeout', {
      data: {},
      maxAttempts: 1,
      timeout: 300.5,
    });
    await manager.pull('fractional-timeout');
    await Bun.sleep(200);
    expect(await manager.getJobState(job.id)).toBe('active');
    expect(await stateAfter(job.id, 'failed')).toBe('failed');
  });

  test.each([0, NaN])('a %p timeout still means no timeout', async (timeout) => {
    manager = new QueueManager();
    const job = await manager.push('fractional-timeout', { data: {}, maxAttempts: 1, timeout });
    await manager.pull('fractional-timeout');
    expect(pendingTimeouts(manager)).toBe(0);
    await Bun.sleep(50);
    expect(await manager.getJobState(job.id)).toBe('active');
  });
});
