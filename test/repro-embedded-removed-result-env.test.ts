/**
 * The embedded shared QueueManager honors the removed-result env settings.
 *
 * `getSharedManager()` (src/client/manager.ts) built its QueueManager with `dataPath`
 * only, so `BUNQUEUE_REMOVED_RESULT_RETENTION_MS` and `BUNQUEUE_MAX_REMOVED_RESULTS`
 * were ignored and an embedded application could neither tune nor turn off the record.
 * It now reads both exactly as the server does: 0 disables the record, a value with no
 * number or below 0 means the default with the server's warning (logged once), and a
 * value `parseInt` misread stops with the server's error.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { QueueManager } from '../src/application/queueManager';
import { getSharedManager, shutdownManager } from '../src/client/manager';
import { ConfigError, resolveServerConfig } from '../src/config';
import { readRemovedResultRetention } from '../src/config/componentEnv';

const RETENTION = 'BUNQUEUE_REMOVED_RESULT_RETENTION_MS';
const MAX = 'BUNQUEUE_MAX_REMOVED_RESULTS';
const saved = { [RETENTION]: Bun.env[RETENTION], [MAX]: Bun.env[MAX] };

function setEnv(values: Partial<Record<typeof RETENTION | typeof MAX, string>>): void {
  for (const name of [RETENTION, MAX] as const) {
    if (values[name] === undefined) delete Bun.env[name];
    else Bun.env[name] = values[name];
  }
}

afterEach(() => {
  shutdownManager();
  for (const name of [RETENTION, MAX] as const) {
    if (saved[name] === undefined) delete Bun.env[name];
    else Bun.env[name] = saved[name];
  }
});

/** Complete one job removed on completion; true when its result is still retained. */
async function retainsRemovedResult(manager: QueueManager): Promise<boolean> {
  const queue = `rr-env-${crypto.randomUUID()}`;
  await manager.push(queue, { data: {}, removeOnComplete: true });
  const pulled = await manager.pull(queue);
  if (!pulled) throw new Error('no job pulled');
  await manager.ack(pulled.id, { answer: 42 });
  const completion = await manager.getCompletionAsync(pulled.id);
  const retained = manager.getMemoryStats().removedResults;
  expect(completion.found).toBe(retained === 1);
  return completion.found;
}

describe('embedded shared manager: removed-result env settings', () => {
  test('unset: the record is on with the defaults', async () => {
    setEnv({});
    expect(await retainsRemovedResult(getSharedManager())).toBe(true);
  });

  test(`${MAX}=0 turns the record off`, async () => {
    setEnv({ [MAX]: '0' });
    expect(await retainsRemovedResult(getSharedManager())).toBe(false);
  });

  test(`${RETENTION}=0 turns the record off`, async () => {
    setEnv({ [RETENTION]: '0' });
    expect(await retainsRemovedResult(getSharedManager())).toBe(false);
  });

  test('an invalid value means the default, with the warning the server reports', async () => {
    const value = `not-a-number-${crypto.randomUUID()}`;
    setEnv({ [MAX]: value });
    const serverWarnings = resolveServerConfig(null, { [MAX]: value }).configWarnings;
    const ours = serverWarnings.filter((warning) => warning.includes(MAX));
    expect(ours).toEqual([
      `Invalid ${MAX}: ${JSON.stringify(value)} (expected a whole number >= 0); using 1000`,
    ]);
    // resolveServerConfig marks its warnings reported (as the server does at boot), so
    // the embedded reader is checked with a value no one has reported yet.
    const fresh = `${value}-embedded`;
    setEnv({ [MAX]: fresh });
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await retainsRemovedResult(getSharedManager())).toBe(true);
      shutdownManager();
      getSharedManager();
      const logged = warn.mock.calls.map((call) => String(call[0])).filter((m) => m.includes(MAX));
      expect(logged).toEqual([
        `[Config] Invalid ${MAX}: ${JSON.stringify(fresh)} (expected a whole number >= 0); using 1000`,
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test('a misread value stops with the error the server stops with', () => {
    setEnv({ [RETENTION]: '5s' });
    let serverError: unknown;
    try {
      resolveServerConfig(null, { [RETENTION]: '5s' });
    } catch (error) {
      serverError = error;
    }
    expect(serverError).toBeInstanceOf(ConfigError);
    expect(() => getSharedManager()).toThrow((serverError as Error).message);
    // Nothing was half-initialized: a valid environment starts normally afterwards.
    setEnv({});
    expect(getSharedManager()).toBeDefined();
  });
});

describe('readRemovedResultRetention matches the server parsing', () => {
  const outcome = (read: () => unknown) => {
    try {
      return { value: read() };
    } catch (error) {
      return { error: (error as Error).message };
    }
  };
  const values = ['', '0', '1', '250', '60000ms', ' 42 ', '-1', 'abc', '+7', '7.0', '1e12'];
  for (const raw of values) {
    test(`${JSON.stringify(raw)}`, () => {
      const env = { [RETENTION]: raw, [MAX]: raw };
      const server = outcome(() => {
        const resolved = resolveServerConfig(null, env);
        return {
          removedResultRetentionMs: resolved.removedResultRetentionMs,
          maxRemovedResults: resolved.maxRemovedResults,
        };
      });
      expect(outcome(() => readRemovedResultRetention(env))).toEqual(server);
    });
  }
});
