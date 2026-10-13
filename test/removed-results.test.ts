/**
 * Unit tests of the removed-result retention (`src/application/removedResults.ts`) and
 * of its configuration (QueueManager config, server env/file/flags). Issue #155 A: the
 * result of a job removed on completion stays readable by the completion lookup for a
 * short, bounded time, in memory only. The engine-level behavior is covered by
 * removed-results-engine.test.ts and repro-issue-155-removed-result-retention.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { RemovedResults, REMOVED_RESULT_DEFAULTS } from '../src/application/removedResults';
import {
  normalizeRemovedResultSetting,
  resolveQueueManagerConfig,
} from '../src/application/types/config';
import { parseCliFlags } from '../src/cli/commands/server';
import { resolveServerConfig } from '../src/config/resolve';
import { jobId, type JobId } from '../src/domain/types/job';
import { outcome, withEnv } from './config-test-support';

/** A manual clock, in ms. */
function manualClock(start = 1_000) {
  let now = start;
  return {
    read: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

const id = (value: string): JobId => jobId(value);

function retention(ttlMs: number, maxEntries: number, clock = manualClock()) {
  return { store: new RemovedResults({ ttlMs, maxEntries, clock: clock.read }), clock };
}

describe('RemovedResults', () => {
  test('a record answers until its TTL elapses, then it is gone', () => {
    const { store, clock } = retention(100, 10);
    store.record(id('a'), 'q', { answer: 42 });

    clock.advance(99);
    expect(store.lookup(id('a'))).toEqual({ queue: 'q', result: { answer: 42 }, expiresAt: 1_100 });
    clock.advance(1);
    expect(store.lookup(id('a'))).toBeUndefined();
    expect(store.size).toBe(0);
  });

  test('an undefined result is still a completion', () => {
    const { store } = retention(100, 10);
    store.record(id('a'), 'q', undefined);

    const record = store.lookup(id('a'));
    expect(record).toBeDefined();
    expect(record?.result).toBeUndefined();
  });

  test('over the cap the oldest records are evicted first, in batches of 10%', () => {
    const { store } = retention(60_000, 10);
    for (let n = 0; n < 10; n++) store.record(id(`j${n}`), 'q', n);
    expect(store.size).toBe(10);

    store.record(id('j10'), 'q', 10);

    // ceil(10 * 10%) = 1: only the oldest one goes.
    expect(store.size).toBe(10);
    expect(store.lookup(id('j0'))).toBeUndefined();
    for (let n = 1; n <= 10; n++) expect(store.lookup(id(`j${n}`))?.result).toBe(n);
  });

  test('the cap is never exceeded and the newest records survive', () => {
    const { store } = retention(60_000, 100);
    for (let n = 0; n < 1_000; n++) {
      store.record(id(`j${n}`), 'q', n);
      expect(store.size).toBeLessThanOrEqual(100);
    }
    for (let n = 990; n < 1_000; n++) expect(store.lookup(id(`j${n}`))?.result).toBe(n);
    expect(store.lookup(id('j0'))).toBeUndefined();
  });

  test('an insert evicts the expired head records', () => {
    const { store, clock } = retention(100, 10);
    store.record(id('old-1'), 'q', 1);
    store.record(id('old-2'), 'q', 2);
    clock.advance(60);
    store.record(id('mid'), 'q', 3);
    clock.advance(50);

    store.record(id('new'), 'q', 4);

    expect(store.size).toBe(2);
    expect(store.lookup(id('mid'))?.result).toBe(3);
    expect(store.lookup(id('new'))?.result).toBe(4);
  });

  test('purgeExpired drops expired records without any new insert', () => {
    const { store, clock } = retention(100, 10);
    store.record(id('a'), 'q', 1);
    store.record(id('b'), 'q', 2);
    clock.advance(50);
    store.record(id('c'), 'q', 3);

    expect(store.purgeExpired()).toBe(0);
    clock.advance(50);
    expect(store.purgeExpired()).toBe(2);
    expect(store.size).toBe(1);
    clock.advance(50);
    expect(store.purgeExpired()).toBe(1);
    expect(store.size).toBe(0);
    expect(store.purgeExpired()).toBe(0);
  });

  test('re-recording an ID moves it to the tail with a fresh TTL', () => {
    const { store, clock } = retention(100, 10);
    store.record(id('a'), 'q', 'first'); // expires at 1100
    clock.advance(50);
    store.record(id('b'), 'q', 'b'); // expires at 1150
    clock.advance(10);
    store.record(id('a'), 'q', 'second'); // expires at 1160, behind b
    clock.advance(60);

    expect(store.purgeExpired()).toBe(0);
    expect(store.lookup(id('a'))?.result).toBe('second');
    clock.advance(30);
    expect(store.purgeExpired()).toBe(1);
    expect(store.lookup(id('b'))).toBeUndefined();
    expect(store.lookup(id('a'))?.result).toBe('second');
  });

  test('forget, forgetQueue and clear drop records', () => {
    const { store } = retention(60_000, 10);
    store.record(id('a'), 'q1', 1);
    store.record(id('b'), 'q2', 2);
    store.record(id('c'), 'q1', 3);

    expect(store.forget(id('a'))).toBe(true);
    expect(store.forget(id('a'))).toBe(false);
    expect(store.forgetQueue('q1')).toBe(1);
    expect(store.lookup(id('c'))).toBeUndefined();
    expect(store.lookup(id('b'))?.result).toBe(2);
    store.clear();
    expect(store.size).toBe(0);
    store.record(id('d'), 'q1', 4);
    expect(store.lookup(id('d'))?.result).toBe(4);
  });

  test('a TTL or a cap of 0 disables the retention', () => {
    for (const [ttlMs, maxEntries] of [
      [0, 10],
      [100, 0],
    ]) {
      const { store } = retention(ttlMs, maxEntries);
      expect(store.enabled).toBe(false);
      store.record(id('a'), 'q', 1);
      expect(store.size).toBe(0);
      expect(store.lookup(id('a'))).toBeUndefined();
    }
  });

  test('the defaults are 60 s and 1,000 records', () => {
    expect(REMOVED_RESULT_DEFAULTS).toEqual({ ttlMs: 60_000, maxEntries: 1_000 });
  });
});

describe('QueueManager config normalization', () => {
  test('defaults to 60000 ms and 1000 records', () => {
    const resolved = resolveQueueManagerConfig({});
    expect(resolved.removedResultRetentionMs).toBe(60_000);
    expect(resolved.maxRemovedResults).toBe(1_000);
  });

  test('keeps 0 (disabled) and rounds a fraction down', () => {
    const resolved = resolveQueueManagerConfig({
      removedResultRetentionMs: 0,
      maxRemovedResults: 12.9,
    });
    expect(resolved.removedResultRetentionMs).toBe(0);
    expect(resolved.maxRemovedResults).toBe(12);
  });

  test.each([Number.NaN, -1, Number.POSITIVE_INFINITY, '5000', null, undefined])(
    'normalizes %p to the default instead of throwing',
    (value) => {
      expect(normalizeRemovedResultSetting(value, 60_000)).toBe(60_000);
      expect(() =>
        resolveQueueManagerConfig({ removedResultRetentionMs: value as number })
      ).not.toThrow();
    }
  );
});

describe('server configuration', () => {
  const env = withEnv();
  afterEach(() => env.restore());

  const resolveWith = (vars: Record<string, string | undefined>, file = null as never) => {
    env.set({
      BUNQUEUE_REMOVED_RESULT_RETENTION_MS: undefined,
      BUNQUEUE_MAX_REMOVED_RESULTS: undefined,
      ...vars,
    });
    return outcome(() => resolveServerConfig(file));
  };

  test('defaults', () => {
    expect(resolveWith({})).toEqual({
      value: expect.objectContaining({
        removedResultRetentionMs: 60_000,
        maxRemovedResults: 1_000,
      }),
    });
  });

  test('reads the env vars, 0 included', () => {
    expect(
      resolveWith({
        BUNQUEUE_REMOVED_RESULT_RETENTION_MS: '0',
        BUNQUEUE_MAX_REMOVED_RESULTS: '500',
      })
    ).toEqual({
      value: expect.objectContaining({ removedResultRetentionMs: 0, maxRemovedResults: 500 }),
    });
  });

  test('an unusable env value means the default, with a warning', () => {
    const result = resolveWith({
      BUNQUEUE_REMOVED_RESULT_RETENTION_MS: '-5',
      BUNQUEUE_MAX_REMOVED_RESULTS: 'abc',
    });
    expect(result).toEqual({
      value: expect.objectContaining({
        removedResultRetentionMs: 60_000,
        maxRemovedResults: 1_000,
      }),
    });
    const warnings = 'value' in result ? result.value.configWarnings : [];
    expect(warnings.join('\n')).toContain('BUNQUEUE_REMOVED_RESULT_RETENTION_MS');
    expect(warnings.join('\n')).toContain('BUNQUEUE_MAX_REMOVED_RESULTS');
  });

  test('the config file wins over env; an invalid file value means the default', () => {
    const file = { storage: { removedResultRetentionMs: 5_000, maxRemovedResults: -1 } };
    expect(resolveWith({ BUNQUEUE_REMOVED_RESULT_RETENTION_MS: '9' }, file as never)).toEqual({
      value: expect.objectContaining({
        removedResultRetentionMs: 5_000,
        maxRemovedResults: 1_000,
      }),
    });
  });

  test('bunqueue start flags; an invalid one is ignored with a warning', () => {
    expect(
      parseCliFlags(['--removed-result-retention-ms', '0', '--max-removed-results', '250'])
    ).toMatchObject({ removedResultRetentionMs: 0, maxRemovedResults: 250 });
    expect(parseCliFlags(['--max-removed-results', 'lots']).maxRemovedResults).toBeUndefined();
  });
});
