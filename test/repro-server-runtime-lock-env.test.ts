/**
 * Repro: LOCK_TIMEOUT_MS was read with a raw parseInt and fed straight to setTimeout.
 *
 * `abc` (NaN) or a value above 2^31 - 1 made every contended AsyncLock/RWLock acquire
 * reject with LockTimeoutError after about a millisecond, and `-1` rejected it at once,
 * in the server and in embedded mode alike. Each case runs in a fresh process because
 * the variable is read once per process.
 */

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO, TIMER_WARNING, runChild } from './server-runtime-support';

setDefaultTimeout(60_000);

/** Hold each lock for 100 ms while a second acquire waits; report how each wait ended. */
const CONTENTION_PROBE = `
  const { AsyncLock, RWLock } = await import('${REPO}/src/shared/lock.ts');
  const outcome = (pending: Promise<{ release(): void }>): Promise<string> =>
    pending.then(
      (guard) => {
        guard.release();
        return 'acquired';
      },
      (error: Error) => error.name
    );
  const rw = new RWLock();
  const writer = await rw.acquireWrite();
  const read = outcome(rw.acquireRead());
  const write = outcome(rw.acquireWrite());
  const mutex = new AsyncLock();
  const holder = await mutex.acquire();
  const exclusive = outcome(mutex.acquire());
  await Bun.sleep(100);
  writer.release();
  holder.release();
  report({ read: await read, write: await write, exclusive: await exclusive });
`;

const MANAGER_PROBE = `
  const { QueueManager } = await import('${REPO}/src/application/queueManager.ts');
  const manager = new QueueManager();
  manager.shutdown();
  report({ constructed: true });
`;

describe('LOCK_TIMEOUT_MS', () => {
  test('a timeout above the native timer limit waits for the holder instead of failing in 1 ms', async () => {
    const result = await runChild(CONTENTION_PROBE, { LOCK_TIMEOUT_MS: '99999999999' });
    expect(result.report).toEqual({
      ok: true,
      read: 'acquired',
      write: 'acquired',
      exclusive: 'acquired',
    });
    expect(result.output).not.toMatch(TIMER_WARNING);
  });

  test('the default still bounds a wait that outlives the holder', async () => {
    const result = await runChild(CONTENTION_PROBE, { LOCK_TIMEOUT_MS: '20' });
    expect(result.report).toEqual({
      ok: true,
      read: 'LockTimeoutError',
      write: 'LockTimeoutError',
      exclusive: 'LockTimeoutError',
    });
  });

  test('malformed values fail QueueManager construction, naming the variable', async () => {
    const raws = ['abc', '-1', '0', '1e3', '5s', ' '];
    const results = await Promise.all(
      raws.map((raw) => runChild(MANAGER_PROBE, { LOCK_TIMEOUT_MS: raw }))
    );
    for (const [index, raw] of raws.entries()) {
      expect(results[index].report).toEqual({
        ok: false,
        name: 'Error',
        error: `Invalid LOCK_TIMEOUT_MS: ${JSON.stringify(raw)} (expected a whole number of milliseconds >= 1)`,
      });
    }
  });

  test('an unset variable keeps the 5 s default and constructs normally', async () => {
    const result = await runChild(MANAGER_PROBE, {});
    expect(result.report).toEqual({ ok: true, constructed: true });
  });
});
