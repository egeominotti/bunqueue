/**
 * PostgreSQL legacy flow-parent repair maintenance: health and timers.
 *
 * - A pass with a failing edge keeps the `flow-failure-repair` health entry recorded
 *   while its retry is pending and through every slice of the retry pass, until a
 *   pass completes cleanly (a no-op slice must not report success).
 * - After a clean pass no repair timer stays armed; `stop()` clears an armed retry
 *   timer, and a later start after the retry is due finishes the repair.
 * - In a broker, the timer is gone after the clean startup pass and after shutdown.
 *
 * A failing edge is a candidate whose child payload cannot be decoded.
 */
import { afterAll, afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { FailureReason } from '../src/domain/types/dlq';
import type { JobId } from '../src/domain/types/job';
import { PostgresFlowFailureMaintenance } from '../src/infrastructure/persistence/postgres/flowFailureMaintenance';
import {
  POSTGRES_FLOW_FAILURE_REPAIR_RETRY_MS,
  postgresFlowFailureRepairDone,
  repairPostgresMissingFlowFailures,
} from '../src/infrastructure/persistence/postgres/flowFailureRepair';
import { eventually, postgresManagerStore } from './support/postgres-event-race';
import {
  chain,
  cleanupLegacyNamespaces,
  ERROR,
  failLikeOlderVersion,
  postgresUrl,
  start,
  state,
  stop,
  stopWriter,
  type Fixture,
} from './support/postgres-legacy-flow-state';

afterAll(cleanupLegacyNamespaces);
afterEach(() => setSystemTime());

const SUBSYSTEM = 'flow-failure-repair';

/** A runner that keeps a health map the way the runtime's maintenance flights do. */
function healthRunner() {
  const health = new Map<string, unknown>();
  const run = async (operation: () => Promise<unknown>, subsystem: string) => {
    try {
      await operation();
      health.delete(subsystem);
    } catch (error) {
      health.set(subsystem, error);
    }
  };
  return { health, run };
}

/** A stuck legacy parent whose child payload is unreadable: its edge always fails. */
async function failingEdge(
  fixture: Fixture
): Promise<{ parent: JobId; restore: () => Promise<void> }> {
  const [parent, child] = await chain(fixture, ['removeDependencyOnFailure']);
  await stopWriter(fixture);
  await failLikeOlderVersion(fixture, child, FailureReason.MaxAttemptsExceeded, ERROR);
  const [row] = await fixture.sql<Array<{ payload: Uint8Array }>>`
    SELECT payload FROM bunqueue_jobs WHERE namespace = ${fixture.namespace} AND id = ${String(child)}
  `;
  const corrupt = new Uint8Array([0]);
  await fixture.sql`
    UPDATE bunqueue_jobs SET payload = ${corrupt}
    WHERE namespace = ${fixture.namespace} AND id = ${String(child)}
  `;
  const restore = async () => {
    await fixture.sql`
      UPDATE bunqueue_jobs SET payload = ${row.payload}
      WHERE namespace = ${fixture.namespace} AND id = ${String(child)}
    `;
  };
  return { parent, restore };
}

/** Edges sorting before every UUID job id and matching no job: never candidates. */
async function fillerEdges(fixture: Fixture, count: number): Promise<void> {
  await fixture.sql`
    INSERT INTO bunqueue_dependencies (namespace, job_id, dependency_id)
    SELECT ${fixture.namespace}, '000-filler-' || lpad(g::text, 6, '0'), 'missing'
    FROM generate_series(1, ${count}::int) AS g
  `;
}

describe('PostgreSQL legacy flow repair maintenance', () => {
  test.skipIf(!postgresUrl)(
    'a failing edge stays unhealthy until a pass completes cleanly',
    async () => {
      const fixture = await start('health');
      try {
        const { parent, restore } = await failingEdge(fixture);
        await fillerEdges(fixture, 3);
        const ctx = { ...fixture.ctx };
        const { health, run } = healthRunner();
        const slice = () => run(() => repairPostgresMissingFlowFailures(ctx, 1, 1), SUBSYSTEM);

        // Pass 1: filler edges, then the failing edge, then the end of the table.
        for (let index = 0; index < 6; index++) await slice();
        expect(health.get(SUBSYSTEM)).toBeInstanceOf(AggregateError);
        // While the retry is pending, every slice is a no-op that keeps the error.
        for (let index = 0; index < 3; index++) await slice();
        expect(health.has(SUBSYSTEM)).toBe(true);

        await restore();
        setSystemTime(new Date(Date.now() + POSTGRES_FLOW_FAILURE_REPAIR_RETRY_MS + 1_000));
        // Pass 2 reads the fillers first: those slices succeed but the error stays.
        await slice();
        expect(health.has(SUBSYSTEM)).toBe(true);
        for (let index = 0; index < 6 && !postgresFlowFailureRepairDone(ctx); index++) {
          await slice();
        }
        expect(postgresFlowFailureRepairDone(ctx)).toBe(true);
        expect(health.has(SUBSYSTEM)).toBe(false);
        expect((await state(fixture, parent)).state).toBe('delayed');
      } finally {
        await stop(fixture);
      }
    },
    30_000
  );

  test.skipIf(!postgresUrl)(
    'no timer stays armed after a clean pass; stop clears a pending retry',
    async () => {
      const fixture = await start('timer');
      try {
        const { parent, restore } = await failingEdge(fixture);
        const ctx = { ...fixture.ctx };
        const { health, run } = healthRunner();
        const maintenance = new PostgresFlowFailureMaintenance(ctx, run);

        maintenance.start();
        expect(maintenance.armed).toBe(true);
        expect(await eventually(() => health.has(SUBSYSTEM), 5_000)).toBe(true);
        // The failed pass leaves only the retry timer armed.
        expect(maintenance.armed).toBe(true);
        maintenance.stop();
        expect(maintenance.armed).toBe(false);

        // Once the retry is due, starting again finishes the repair and disarms.
        await restore();
        setSystemTime(new Date(Date.now() + POSTGRES_FLOW_FAILURE_REPAIR_RETRY_MS + 1_000));
        maintenance.start();
        expect(await eventually(() => postgresFlowFailureRepairDone(ctx), 5_000)).toBe(true);
        expect(await eventually(() => !maintenance.armed, 5_000)).toBe(true);
        expect(health.has(SUBSYSTEM)).toBe(false);
        expect((await state(fixture, parent)).state).toBe('delayed');
        maintenance.start();
        expect(maintenance.armed).toBe(false);
      } finally {
        await stop(fixture);
      }
    },
    30_000
  );

  test.skipIf(!postgresUrl)(
    'a broker disarms the repair after its clean pass and on shutdown',
    async () => {
      const fixture = await start('broker');
      try {
        const store = postgresManagerStore(fixture.manager!);
        const maintenance = Reflect.get(store, 'flowFailures') as PostgresFlowFailureMaintenance;
        expect(await eventually(() => postgresFlowFailureRepairDone(store.context), 5_000)).toBe(
          true
        );
        expect(await eventually(() => !maintenance.armed, 5_000)).toBe(true);
        await stopWriter(fixture);
        expect(maintenance.armed).toBe(false);
      } finally {
        await stop(fixture);
      }
    },
    30_000
  );
});
