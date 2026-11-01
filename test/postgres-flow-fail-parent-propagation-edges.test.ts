/**
 * PostgreSQL recursive flow-failure propagation, edge paths: a late link of an
 * already-failed child propagates through a parent with its own policy; a record left
 * on a parent that failed first is dropped by the sweep, while an applied value on a
 * live parent is kept; and a record that keeps failing cannot starve the others.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { PostgresQueueManager } from '../src/application/postgresQueueManager';
import type { Job, JobId, JobInput } from '../src/domain/types/job';
import type { PostgresContext } from '../src/infrastructure/persistence/postgres/context';
import { recoverPostgresFlowFailurePropagations } from '../src/infrastructure/persistence/postgres/flowFailurePropagation';
import { failPostgresJob } from '../src/infrastructure/persistence/postgres/outcomes';
import { updatePostgresJobParent } from '../src/infrastructure/persistence/postgres/relationships';
import { cleanupPostgresNamespace, postgresRaceContext } from './support/postgres-event-race';

const postgresUrl = Bun.env.BUNQUEUE_TEST_POSTGRES_URL;
const namespaces: string[] = [];
const QUEUE = 'flow-propagation-edges';

interface Fixture {
  readonly namespace: string;
  readonly manager: PostgresQueueManager;
  readonly sql: SQL;
  readonly ctx: PostgresContext;
}

async function withFixture(label: string, body: (fixture: Fixture) => Promise<void>) {
  const namespace = `test-flow-propagation-${label}-${Date.now()}-${crypto.randomUUID()}`;
  namespaces.push(namespace);
  const manager = new PostgresQueueManager({
    postgres: { url: postgresUrl!, namespace, brokerId: label },
  });
  const sql = new SQL(postgresUrl!, { max: 2 });
  try {
    await manager.waitUntilReady();
    await body({ namespace, manager, sql, ctx: postgresRaceContext(manager, sql) });
  } finally {
    await Promise.allSettled([manager.shutdownPostgres(), sql.close({ timeout: 5 })]);
  }
}

async function push(fixture: Fixture, name: string, input: Partial<JobInput> = {}): Promise<Job> {
  return await fixture.manager.push(QUEUE, { data: { name }, delay: 600_000, ...input });
}

/** Push a standalone job and fail it terminally through a worker FAIL. */
async function failedJob(fixture: Fixture, input: Partial<JobInput>): Promise<Job> {
  const job = await fixture.manager.push(QUEUE, { data: {}, maxAttempts: 1, ...input });
  const claim = await fixture.manager.pullWithLock(QUEUE, 'edges-worker');
  expect(claim.job?.id).toBe(job.id);
  await failPostgresJob(fixture.ctx, {
    id: job.id,
    token: claim.token!,
    error: 'boom',
    unrecoverable: true,
  });
  return job;
}

async function state(fixture: Fixture, id: JobId): Promise<string | undefined> {
  const [row] = await fixture.sql<Array<{ state: string }>>`
    SELECT state FROM bunqueue_jobs WHERE namespace = ${fixture.namespace} AND id = ${String(id)}
  `;
  return row?.state;
}

async function records(fixture: Fixture, parentId: JobId): Promise<string[]> {
  const rows = await fixture.sql<Array<{ child_id: string }>>`
    SELECT child_id FROM bunqueue_flow_failures
    WHERE namespace = ${fixture.namespace} AND parent_id = ${String(parentId)}
    ORDER BY child_id
  `;
  return rows.map((row) => row.child_id);
}

async function insertRecord(fixture: Fixture, parentId: JobId, childId: JobId, at: number) {
  await fixture.sql`
    INSERT INTO bunqueue_flow_failures
      (namespace, parent_id, child_id, child_queue, mode, error, created_at)
    VALUES (${fixture.namespace}, ${String(parentId)}, ${String(childId)}, ${QUEUE},
            'ignore', 'stale', ${at})
  `;
}

afterAll(async () => {
  if (!postgresUrl) return;
  for (const namespace of namespaces) await cleanupPostgresNamespace(postgresUrl, namespace);
});

describe('PostgreSQL recursive flow failure propagation edges', () => {
  test.skipIf(!postgresUrl)(
    'a late link of a failed child propagates through a parent with its own policy',
    () =>
      withFixture('late-link', async (fixture) => {
        const gp = await push(fixture, 'gp');
        const mid = await push(fixture, 'mid', { failParentOnFailure: true });
        await updatePostgresJobParent(fixture.ctx, mid.id, gp.id);
        const leaf = await failedJob(fixture, { failParentOnFailure: true });
        expect(await state(fixture, leaf.id)).toBe('failed');

        await updatePostgresJobParent(fixture.ctx, leaf.id, mid.id);

        expect(await state(fixture, mid.id)).toBe('failed');
        expect(await state(fixture, gp.id)).toBe('failed');
        const [row] = await fixture.sql<Array<{ error: string }>>`
          SELECT error FROM bunqueue_jobs
          WHERE namespace = ${fixture.namespace} AND id = ${String(gp.id)}
        `;
        expect(row.error).toBe(`Child job ${mid.id} failed: Child job ${leaf.id} failed: boom`);
      }),
    30_000
  );

  test.skipIf(!postgresUrl)(
    'the sweep drops a record whose parent failed first and keeps an applied value',
    () =>
      withFixture('orphan', async (fixture) => {
        // gp failed by q; p's record toward gp is what a lost race leaves behind.
        const gp = await push(fixture, 'gp');
        const p = await push(fixture, 'p', { ignoreDependencyOnFailure: true });
        await updatePostgresJobParent(fixture.ctx, p.id, gp.id);
        const q = await failedJob(fixture, { failParentOnFailure: true });
        await updatePostgresJobParent(fixture.ctx, q.id, gp.id);
        expect(await state(fixture, gp.id)).toBe('failed');
        await insertRecord(fixture, gp.id, p.id, 1);

        // A live parent with an applied ignore value (its edge is gone).
        const live = await push(fixture, 'live');
        await push(fixture, 'sibling').then((sibling) =>
          updatePostgresJobParent(fixture.ctx, sibling.id, live.id)
        );
        const ignored = await failedJob(fixture, { ignoreDependencyOnFailure: true });
        await updatePostgresJobParent(fixture.ctx, ignored.id, live.id);
        expect(await records(fixture, live.id)).toEqual([String(ignored.id)]);

        await recoverPostgresFlowFailurePropagations(fixture.ctx);

        expect(await records(fixture, gp.id)).toEqual([]);
        expect(await fixture.manager.getIgnoredChildrenFailures(gp.id)).toEqual({});
        expect(await records(fixture, live.id)).toEqual([String(ignored.id)]);
        expect(await state(fixture, live.id)).toBe('waiting-children');
      }),
    30_000
  );

  test.skipIf(!postgresUrl)(
    'a record that keeps failing is reported and does not starve newer ones',
    () =>
      withFixture('poison', async (fixture) => {
        const gp = await push(fixture, 'gp');
        const mid = await push(fixture, 'mid', { failParentOnFailure: true });
        await updatePostgresJobParent(fixture.ctx, mid.id, gp.id);
        const poisonId = `poison-${crypto.randomUUID()}` as JobId;
        // An undecodable child row behind the oldest pending record.
        await fixture.sql`
          INSERT INTO bunqueue_jobs
            (namespace, id, queue, payload, state, run_at, created_at, parent_id)
          VALUES (${fixture.namespace}, ${poisonId}, 'poison-queue',
                  ${new Uint8Array([0xc1, 0xc1, 0xc1])}, 'failed', 0, 0, ${String(gp.id)})
        `;
        await fixture.sql`
          INSERT INTO bunqueue_dependencies (namespace, job_id, dependency_id)
          VALUES (${fixture.namespace}, ${String(gp.id)}, ${poisonId})
        `;
        await insertRecord(fixture, gp.id, poisonId, 0);
        try {
          // mid fails by a late-linked failed leaf, but its own level is left pending.
          const leaf = await failedJob(fixture, { failParentOnFailure: true });
          const crashing: PostgresContext = {
            ...fixture.ctx,
            postCommitMaintenance: async (subsystem, operation) => {
              if (!subsystem.startsWith('flow-failure:')) await operation();
            },
          };
          await updatePostgresJobParent(crashing, leaf.id, mid.id);
          expect(await state(fixture, mid.id)).toBe('failed');
          expect(await state(fixture, gp.id)).toBe('waiting-children');

          // Page size 1: the poison record comes first on every page walk.
          const sweep = recoverPostgresFlowFailurePropagations(fixture.ctx, 1);
          await expect(sweep).rejects.toThrow(`parent ${gp.id} <- child ${poisonId}`);
          expect(await state(fixture, gp.id)).toBe('failed');
        } finally {
          await fixture.sql`
            DELETE FROM bunqueue_jobs WHERE namespace = ${fixture.namespace} AND id = ${poisonId}
          `;
        }
      }),
    30_000
  );
});
