/**
 * Repro: retries waited a full pollIntervalMs, and one failure delayed every
 * queued projection refresh.
 *
 * - The runtime retried failed post-commit maintenance after pollIntervalMs, so with
 *   a 60 s poll interval a transient failure stayed unrepaired for a minute.
 * - A failed projection batch armed its retry timer and every later request queued
 *   behind it: a fresh event's refresh waited for the failure's retry delay.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { jobId, type JobId } from '../src/domain/types/job';
import {
  PostgresProjectionRefreshes,
  type PostgresJobProjection,
} from '../src/application/postgres-queue-manager/projectionRefreshes';
import { PostgresQueueStoreRuntime } from '../src/infrastructure/persistence/postgres/runtime';
import { eventually } from './support/postgres-event-race';

const emptyProjection: PostgresJobProjection = { row: null, completion: null };
const cleanups: Array<() => Promise<unknown> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('PostgreSQL retry delays and starvation', () => {
  test('post-commit maintenance retries within about 1 s even with a 60 s poll interval', async () => {
    const runtime = new PostgresQueueStoreRuntime({
      url: 'postgres://bunqueue:unused@127.0.0.1:1/never',
      namespace: 'retry-cap',
      brokerId: 'retry-cap',
      pollIntervalMs: 60_000,
    });
    cleanups.push(async () => {
      (runtime as unknown as { stopMaintenance(): void }).stopMaintenance();
      await runtime.context.sql.close({ timeout: 1 });
    });
    let attempts = 0;

    await runtime.context.postCommitMaintenance!('completion-retention', async () => {
      attempts++;
      if (attempts === 1) throw new Error('transient failure');
    });

    expect(await eventually(() => attempts === 2, 2_500)).toBe(true);
  });

  test('a fresh projection refresh does not wait behind a failed batch retry', async () => {
    const applied: JobId[] = [];
    let loads = 0;
    const refreshes = new PostgresProjectionRefreshes(
      async (requests) => {
        loads++;
        if (loads === 1) throw new Error('transient projection failure');
        return new Map(requests.map(({ id }) => [id, emptyProjection]));
      },
      (id) => applied.push(id),
      () => undefined,
      60_000
    );
    cleanups.push(async () => {
      refreshes.close();
      await refreshes.drain();
    });
    refreshes.start();
    refreshes.request(jobId('failed-first'), 'queue');
    expect(await eventually(() => loads === 1)).toBe(true);
    await refreshes.drain();

    refreshes.request(jobId('fresh'), 'queue');

    expect(await eventually(() => applied.includes(jobId('fresh')), 1_000)).toBe(true);
    // The failed request rides along with the fresh batch instead of waiting 60 s.
    expect(applied).toContain(jobId('failed-first'));
  });
});
