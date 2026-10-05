/**
 * Repro: PostgreSQL retry timers stormed instead of waiting their delay.
 *
 * - Post-commit maintenance re-started a failed flight from its own `finally`
 *   handler, so the retry timer was bypassed and a failing operation ran back to
 *   back (with an operation that rejects without yielding, the loop never yields
 *   to the event loop at all).
 * - Post-commit maintenance retries after max(25, pollIntervalMs) and projection
 *   refreshes after pollIntervalMs. Above 2^31 - 1 ms Bun armed both after about
 *   1 ms, so a failing database call ran hundreds of times per second.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { jobId } from '../src/domain/types/job';
import { PostgresProjectionRefreshes } from '../src/application/postgres-queue-manager/projectionRefreshes';
import { PostgresPostCommitMaintenance } from '../src/infrastructure/persistence/postgres/postCommitMaintenance';
import { eventually } from './support/postgres-event-race';

const BEYOND_TIMER_LIMIT_MS = 2 ** 31;
const OBSERVATION_MS = 100;
const cleanups: Array<() => Promise<unknown> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A failing database call: it settles on a later macrotask, as a real query does. */
async function unavailable(): Promise<never> {
  await Bun.sleep(1);
  throw new Error('database unavailable');
}

function maintenance(retryDelayMs: number, reports: unknown[] = []) {
  const value = new PostgresPostCommitMaintenance((_subsystem, error) => {
    reports.push(error);
  }, retryDelayMs);
  cleanups.push(async () => {
    value.close();
    await value.drain();
  });
  return value;
}

describe('PostgreSQL retry delays', () => {
  test('post-commit maintenance waits for its retry delay', async () => {
    const reports: unknown[] = [];
    const retries = maintenance(10_000, reports);
    let attempts = 0;

    await retries.run('completion-retention', async () => {
      attempts++;
      await unavailable();
    });
    await Bun.sleep(OBSERVATION_MS);

    expect(attempts).toBe(1);
    expect(reports).toHaveLength(1);
  });

  test('post-commit maintenance retries once per delay beyond the timer limit', async () => {
    const retries = maintenance(BEYOND_TIMER_LIMIT_MS);
    let attempts = 0;

    await retries.run('completion-retention', async () => {
      attempts++;
      await unavailable();
    });
    await Bun.sleep(OBSERVATION_MS);

    expect(attempts).toBe(1);
  });

  test('post-commit maintenance still retries after a short delay and reports recovery', async () => {
    const reports: unknown[] = [];
    const retries = maintenance(20, reports);
    let attempts = 0;

    await retries.run('completion-retention', async () => {
      attempts++;
      if (attempts === 1) await unavailable();
    });

    expect(await eventually(() => attempts === 2)).toBe(true);
    await retries.drain();
    expect(reports).toHaveLength(2);
    expect(reports[0]).toBeInstanceOf(Error);
    expect(reports[1]).toBeNull();
  });

  test('projection refreshes retry a failed load once per delay beyond the timer limit', async () => {
    let attempts = 0;
    const refreshes = new PostgresProjectionRefreshes(
      async () => {
        attempts++;
        return await unavailable();
      },
      () => undefined,
      () => undefined,
      BEYOND_TIMER_LIMIT_MS
    );
    cleanups.push(async () => {
      refreshes.close();
      await refreshes.drain();
    });

    refreshes.start();
    refreshes.request(jobId('retry-storm'), 'queue');
    await Bun.sleep(OBSERVATION_MS);

    expect(attempts).toBe(1);
  });
});
