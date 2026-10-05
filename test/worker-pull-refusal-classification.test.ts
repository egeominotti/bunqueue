/**
 * Which pull failures pass with time (`workerPull.ts`). A transient one is retried
 * with backoff and reported only to an attached `error` listener; a permanent one is
 * always reported. The transient set reuses the job wait's (`job-wait/types.ts`) and
 * adds the `Internal server error` a broker returns for a redacted storage failure and
 * the lock timeouts (`shared/lockError.ts`) it returns under shard contention.
 */
import { describe, expect, test } from 'bun:test';
import {
  PullRefusedError,
  isTransientPullError,
  isTransientRefusal,
} from '../src/client/worker/workerPull';

describe('pull failure classification', () => {
  test.each([
    ['Rate limit exceeded', true],
    ['Internal server error', true],
    ['Lock acquisition timed out', true],
    ['Read lock acquisition timed out', true],
    ['Write lock acquisition timed out', true],
    ['Not authenticated', false],
    ['Queue name contains invalid characters', false],
    ['lockTtl must be at least 1', false],
    [undefined, false],
  ])('a refusal with error %p is transient: %p', (error, transient) => {
    const response = { ok: false, error };
    expect(isTransientRefusal(response)).toBe(transient);
    const refusal = new PullRefusedError('PULLB', response);
    expect(refusal.transient).toBe(transient);
    expect(isTransientPullError(refusal)).toBe(transient);
    expect(refusal.message).toBe(`PULLB refused by the broker: ${error ?? 'no reason given'}`);
  });

  test.each([
    ['Command timeout', true],
    ['Connection lost', true],
    ['Not connected', true],
    ['Connection pool is closed', false],
    ['boom', false],
  ])('a thrown %p is transient: %p', (message, transient) => {
    expect(isTransientPullError(new Error(message))).toBe(transient);
  });
});
