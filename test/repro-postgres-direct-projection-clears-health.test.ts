import { afterEach, describe, expect, test } from 'bun:test';
import { jobId, type JobId } from '../src/domain/types/job';
import type { QueueManager } from '../src/application/queueManager';
import {
  PostgresProjectionRefreshes,
  type PostgresJobProjection,
} from '../src/application/postgres-queue-manager/projectionRefreshes';
import { PostgresQueueStore } from '../src/infrastructure/persistence/postgres';
import { readinessEndpoint } from '../src/infrastructure/server/httpEndpoints';
import { eventually } from './support/postgres-event-race';

type ProjectionReporter = (queue: string, id: JobId, error: unknown) => void;

interface ProjectionReport {
  readonly queue: string;
  readonly id: JobId;
  readonly error: unknown;
}

interface ProjectionHarness {
  readonly refreshes: PostgresProjectionRefreshes;
  loads: number;
  healthy: boolean;
}

const QUEUE = 'direct-health';
const emptyProjection: PostgresJobProjection = { row: null, completion: null };
const opened: PostgresProjectionRefreshes[] = [];

afterEach(async () => {
  for (const refreshes of opened.splice(0)) {
    refreshes.close();
    await refreshes.drain();
  }
});

function harness(report: ProjectionReporter, retryDelayMs = 60_000): ProjectionHarness {
  const state = { loads: 0, healthy: false } as ProjectionHarness;
  const refreshes = new PostgresProjectionRefreshes(
    async (requests) => {
      state.loads++;
      if (!state.healthy) throw new Error('transient projection outage');
      return new Map(requests.map(({ id }) => [id, emptyProjection]));
    },
    () => undefined,
    report,
    retryDelayMs
  );
  opened.push(refreshes);
  Object.assign(state, { refreshes });
  return state;
}

function recorder(): { reports: ProjectionReport[]; report: ProjectionReporter } {
  const reports: ProjectionReport[] = [];
  return { reports, report: (queue, id, error) => reports.push({ queue, id, error }) };
}

/** Fails one background refresh so an error is recorded and a retry stays pending. */
async function failBackgroundRefresh(state: ProjectionHarness, id: JobId): Promise<void> {
  state.refreshes.start();
  state.refreshes.request(id, QUEUE);
  expect(await eventually(() => state.loads >= 1)).toBe(true);
  await state.refreshes.drain();
  const pending = Reflect.get(state.refreshes, 'pending') as Map<JobId, unknown>;
  expect(pending.has(id)).toBe(true);
}

function pendingRetries(refreshes: PostgresProjectionRefreshes): number {
  return (Reflect.get(refreshes, 'pending') as Map<JobId, unknown>).size;
}

describe('PostgreSQL direct projection health recovery', () => {
  test('a consumed direct lease renewal clears the failed refresh it superseded', async () => {
    const { reports, report } = recorder();
    const state = harness(report);
    const id = jobId('direct-renewal');
    await failBackgroundRefresh(state, id);
    expect(reports).toHaveLength(1);
    expect(reports[0].error).toBeInstanceOf(Error);

    const ticket = state.refreshes.beginDirect(id, QUEUE);
    expect(pendingRetries(state.refreshes)).toBe(0);
    expect(state.refreshes.consumeDirect(ticket)).toBe(true);

    expect(reports.at(-1)).toEqual({ queue: QUEUE, id, error: null });
    expect(pendingRetries(state.refreshes)).toBe(0);
  });

  test('storage readiness recovers after the direct transaction applies authoritative state', async () => {
    const store = new PostgresQueueStore({
      url: 'postgresql://unused:unused@127.0.0.1:1/unused',
      namespace: 'direct-health-unit',
      brokerId: 'direct-health-unit',
    });
    const manager = {
      getStorageStatus: () => {
        const health = store.health();
        return { diskFull: false, error: health.error, since: health.since };
      },
    } as unknown as QueueManager;
    const state = harness((queue, id, error) => store.reportProjectionRefresh(queue, id, error));
    const id = jobId('direct-readiness');
    try {
      await failBackgroundRefresh(state, id);
      expect(readinessEndpoint(manager).status).toBe(503);

      const ticket = state.refreshes.beginDirect(id, QUEUE);
      expect(state.refreshes.consumeDirect(ticket)).toBe(true);

      const response = readinessEndpoint(manager);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { ready: boolean }).ready).toBe(true);
      expect(store.health().error).toBeNull();
    } finally {
      await store.context.sql.close();
    }
  });

  test('an authoritative queue refresh clears the failed refresh it superseded', async () => {
    const { reports, report } = recorder();
    const state = harness(report);
    const id = jobId('queue-supersede');
    await failBackgroundRefresh(state, id);

    state.refreshes.supersedeQueue(QUEUE);

    expect(pendingRetries(state.refreshes)).toBe(0);
    expect(reports.at(-1)).toEqual({ queue: QUEUE, id, error: null });
  });

  test('a local claim clears the failed refresh it superseded', async () => {
    const { reports, report } = recorder();
    const state = harness(report);
    const id = jobId('claim-supersede');
    await failBackgroundRefresh(state, id);

    state.refreshes.supersede(id);

    expect(pendingRetries(state.refreshes)).toBe(0);
    expect(reports.at(-1)).toEqual({ queue: QUEUE, id, error: null });
  });

  test('a cancelled direct mutation leaves the error visible for its repair refresh', async () => {
    const { reports, report } = recorder();
    const state = harness(report);
    const id = jobId('direct-cancel');
    await failBackgroundRefresh(state, id);

    state.refreshes.cancelDirect(state.refreshes.beginDirect(id, QUEUE));

    expect(reports).toHaveLength(1);
    expect(reports[0].error).toBeInstanceOf(Error);
    state.healthy = true;
    await state.refreshes.refreshManyNow([{ id, queue: QUEUE }]);
    expect(reports.at(-1)).toEqual({ queue: QUEUE, id, error: null });
  });

  test('a fenced-out direct ticket leaves health to the newer projection generation', async () => {
    const { reports, report } = recorder();
    const state = harness(report, 1);
    const id = jobId('direct-fenced');
    await failBackgroundRefresh(state, id);
    const recorded = reports.length;

    const ticket = state.refreshes.beginDirect(id, QUEUE);
    state.refreshes.request(id, QUEUE);
    expect(state.refreshes.consumeDirect(ticket)).toBe(false);
    expect(reports).toHaveLength(recorded);
    expect(reports.every(({ error }) => error instanceof Error)).toBe(true);

    state.healthy = true;
    expect(await eventually(() => reports.at(-1)?.error === null)).toBe(true);
    expect(reports.at(-1)).toEqual({ queue: QUEUE, id, error: null });
  });
});
