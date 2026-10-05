/**
 * Repro: the background periods of the public `new QueueManager({...})` config were
 * spread raw into setInterval. NaN, 0, a negative value, Infinity, `undefined` passed
 * explicitly or a value above 2^31 - 1 made the cleanup, dependency, stall, DLQ and
 * lock-expiration intervals tick about every millisecond, and a NaN `jobTimeoutCheckMs`
 * reached the timeout scheduler's retry deadline.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager, type QueueManagerConfig } from '../src/application/queueManager';

const FIELDS = [
  'cleanupIntervalMs',
  'jobTimeoutCheckMs',
  'dependencyCheckMs',
  'stallCheckMs',
  'dlqMaintenanceMs',
] as const;

const LIMIT = 2_147_483_647;
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.setInterval = realSetInterval;
});

/** Construct and immediately shut down; return what the constructor threw, if anything. */
function constructionError(config: QueueManagerConfig): unknown {
  let manager: QueueManager | null = null;
  try {
    manager = new QueueManager(config);
    return null;
  } catch (error) {
    return error;
  } finally {
    manager?.shutdown();
  }
}

/** Record every native timer delay armed until afterEach restores the real functions. */
function recordNativeDelays(): number[] {
  const delays: number[] = [];
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    delays.push(ms as number);
    return realSetTimeout(fn, ms);
  }) as unknown as typeof setTimeout;
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    delays.push(ms as number);
    return realSetInterval(fn, ms);
  }) as unknown as typeof setInterval;
  return delays;
}

describe('QueueManagerConfig background periods', () => {
  test('values that made an interval spin are rejected, naming the option', () => {
    const bad: unknown[] = [Number.NaN, 0, -1, 0.5, Number.POSITIVE_INFINITY];
    for (const field of FIELDS) {
      for (const value of bad) {
        const error = constructionError({ [field]: value } as QueueManagerConfig);
        expect(error).toBeInstanceOf(RangeError);
        expect((error as Error).message).toBe(
          `QueueManager: ${field} must be a finite number of milliseconds >= 1 (got ${Object.is(value, -0) ? '-0' : String(value)})`
        );
      }
    }
  });

  test('non-number values are rejected with a TypeError, naming the option', () => {
    for (const field of FIELDS) {
      for (const value of ['5000', null, {}]) {
        const error = constructionError({ [field]: value } as unknown as QueueManagerConfig);
        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).toContain(`QueueManager: ${field} must be`);
      }
    }
  });

  test('an explicit undefined keeps the default instead of arming a 1 ms interval', () => {
    const delays = recordNativeDelays();
    const config = Object.fromEntries(FIELDS.map((field) => [field, undefined]));
    const manager = new QueueManager(config as QueueManagerConfig);
    manager.shutdown();
    expect(delays.filter((ms) => typeof ms !== 'number')).toStrictEqual([]);
    expect(delays).toContain(5_000);
    expect(delays).toContain(10_000);
    expect(delays).toContain(30_000);
    expect(delays).toContain(60_000);
  });

  test('periods above the native timer limit are honoured: no native delay out of range', () => {
    const delays = recordNativeDelays();
    const manager = new QueueManager({
      cleanupIntervalMs: LIMIT + 1,
      jobTimeoutCheckMs: 30 * 24 * 60 * 60 * 1000,
      dependencyCheckMs: 30 * 24 * 60 * 60 * 1000,
      stallCheckMs: 2 ** 32,
      dlqMaintenanceMs: Number.MAX_SAFE_INTEGER,
    });
    manager.shutdown();
    const outOfRange = delays.filter((ms) => typeof ms !== 'number' || !(ms >= 0 && ms <= LIMIT));
    expect(outOfRange).toStrictEqual([]);
  });

  test('ordinary small periods keep working', () => {
    expect(
      constructionError({
        cleanupIntervalMs: 1,
        jobTimeoutCheckMs: 50,
        dependencyCheckMs: 100,
        stallCheckMs: 200.5,
        dlqMaintenanceMs: 1_000,
      })
    ).toBeNull();
  });
});
