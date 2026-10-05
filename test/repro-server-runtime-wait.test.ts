/**
 * Repro: the public `QueueManager.waitForJobCompletion(jobId, timeoutMs)` passed its
 * timeout straight to setTimeout. TCP/HTTP (0..600000) and MCP (100..30000) validate it,
 * the public method did not: a timeout above 2^31 - 1 resolved `false` after about 1 ms
 * while the job was still running, and NaN, a negative value or Infinity did the same.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { jobId } from '../src/domain/types/job';

let manager: QueueManager | null = null;

afterEach(() => {
  manager?.shutdown();
  manager = null;
});

function waiterCount(qm: QueueManager): number {
  return (qm as unknown as { eventsManager: { completionWaiterCount: number } }).eventsManager
    .completionWaiterCount;
}

describe('QueueManager.waitForJobCompletion timeout', () => {
  test('a timeout above the native timer limit waits for the completion', async () => {
    manager = new QueueManager();
    const job = await manager.push('runtime-wait', { data: { n: 1 } });
    let settled: boolean | null = null;
    const waiting = manager.waitForJobCompletion(job.id, 2 ** 31 + 1_000).then((completed) => {
      settled = completed;
      return completed;
    });
    await Bun.sleep(100);
    expect(settled).toBeNull();

    const pulled = await manager.pull('runtime-wait');
    expect(pulled?.id).toBe(job.id);
    await manager.ack(job.id, { done: true });
    expect(await waiting).toBe(true);
    expect(waiterCount(manager)).toBe(0);
  });

  test('a zero timeout still resolves false on the next tick', async () => {
    manager = new QueueManager();
    const job = await manager.push('runtime-wait', { data: {} });
    expect(await manager.waitForJobCompletion(job.id, 0)).toBe(false);
    expect(waiterCount(manager)).toBe(0);
  });

  test('NaN, negative and infinite timeouts are rejected before a waiter is registered', () => {
    manager = new QueueManager();
    for (const timeoutMs of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      let error: unknown = null;
      try {
        void manager.waitForJobCompletion(jobId('missing'), timeoutMs);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(RangeError);
      expect((error as Error).message).toBe(
        `QueueManager.waitForJobCompletion: timeoutMs must be a finite number of milliseconds >= 0 (got ${String(timeoutMs)})`
      );
      expect(waiterCount(manager)).toBe(0);
    }
  });

  test('a non-number timeout is rejected with a TypeError', () => {
    manager = new QueueManager();
    expect(() =>
      manager!.waitForJobCompletion(jobId('missing'), '100' as unknown as number)
    ).toThrow(TypeError);
    expect(waiterCount(manager)).toBe(0);
  });
});
