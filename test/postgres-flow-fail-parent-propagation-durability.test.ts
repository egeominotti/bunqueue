/**
 * PostgreSQL recursive flow-failure propagation: durability between levels and
 * exactly-once application. A parent failed by its child's failParentOnFailure commits
 * its own policy record (bunqueue_flow_failures, pending while the edge exists) with
 * its failure; every next level runs in its own transaction after that commit. These
 * tests stop the broker between levels and prove a restart (or any broker's recovery
 * sweep) finishes the chain once, never twice.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { PostgresQueueManager } from '../src/application/postgresQueueManager';
import type { Job, JobId, JobInput } from '../src/domain/types/job';
import type { PostgresContext } from '../src/infrastructure/persistence/postgres/context';
import {
  applyPostgresFlowFailurePropagation,
  recoverPostgresFlowFailurePropagations,
} from '../src/infrastructure/persistence/postgres/flowFailurePropagation';
import { failPostgresJob } from '../src/infrastructure/persistence/postgres/outcomes';
import { updatePostgresJobParent } from '../src/infrastructure/persistence/postgres/relationships';
import { cleanupPostgresNamespace, postgresRaceContext } from './support/postgres-event-race';

const postgresUrl = Bun.env.BUNQUEUE_TEST_POSTGRES_URL;
const namespaces: string[] = [];
const QUEUE = 'flow-propagation';

type Policy = 'failParentOnFailure' | 'ignoreDependencyOnFailure';

interface Fixture {
  readonly namespace: string;
  readonly manager: PostgresQueueManager;
  readonly sql: SQL;
  /** A context whose post-commit work is dropped: the broker "crashes" after commit. */
  readonly crashing: PostgresContext;
  readonly live: PostgresContext;
}

async function start(label: string): Promise<Fixture> {
  const namespace = `test-flow-propagation-${label}-${Date.now()}-${crypto.randomUUID()}`;
  namespaces.push(namespace);
  const manager = new PostgresQueueManager({
    postgres: { url: postgresUrl!, namespace, brokerId: `${label}-a` },
  });
  await manager.waitUntilReady();
  const sql = new SQL(postgresUrl!, { max: 4 });
  const live = postgresRaceContext(manager, sql);
  const crashing: PostgresContext = {
    ...live,
    postCommitMaintenance: async (subsystem, operation) => {
      if (subsystem.startsWith('flow-failure:')) return;
      await operation();
    },
  };
  return { namespace, manager, sql, crashing, live };
}

async function stop(fixture: Fixture): Promise<void> {
  await Promise.allSettled([fixture.manager.shutdownPostgres(), fixture.sql.close({ timeout: 5 })]);
}

async function restart(fixture: Fixture, label: string): Promise<void> {
  const manager = new PostgresQueueManager({
    postgres: { url: postgresUrl!, namespace: fixture.namespace, brokerId: `${label}-b` },
  });
  try {
    // Startup recovery runs before the broker reports ready.
    await manager.waitUntilReady();
  } finally {
    await manager.shutdownPostgres();
  }
}

async function push(fixture: Fixture, name: string, input: Partial<JobInput>): Promise<Job> {
  return await fixture.manager.push(QUEUE, { data: { name }, delay: 600_000, ...input });
}

/** Build `nodes[0] <- nodes[1] <- ... <- leaf`; returns the ids, root first. */
async function chain(fixture: Fixture, policies: Array<Policy | null>): Promise<JobId[]> {
  const ids: JobId[] = [];
  for (const [index, policy] of policies.entries()) {
    const job = await push(fixture, `level-${index}`, policy ? { [policy]: true } : {});
    if (index > 0) await updatePostgresJobParent(fixture.live, job.id, ids[index - 1]);
    ids.push(job.id);
  }
  const leaf = await fixture.manager.push(QUEUE, {
    data: { name: 'leaf' },
    failParentOnFailure: true,
    maxAttempts: 1,
  });
  await updatePostgresJobParent(fixture.live, leaf.id, ids[ids.length - 1]);
  ids.push(leaf.id);
  return ids;
}

async function failLeaf(fixture: Fixture, leafId: JobId): Promise<void> {
  const claim = await fixture.manager.pullWithLock(QUEUE, 'propagation-worker');
  expect(claim.job?.id).toBe(leafId);
  const transition = await failPostgresJob(fixture.crashing, {
    id: leafId,
    token: claim.token!,
    error: 'boom',
    unrecoverable: true,
  });
  expect(transition.applied).toBe(true);
}

async function row(fixture: Fixture, id: JobId) {
  const [found] = await fixture.sql<Array<{ state: string; error: string | null }>>`
    SELECT state, error FROM bunqueue_jobs
    WHERE namespace = ${fixture.namespace} AND id = ${String(id)}
  `;
  return found;
}

async function events(fixture: Fixture, id: JobId, type: string): Promise<number> {
  const [found] = await fixture.sql<Array<{ count: number | string | bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM bunqueue_events
    WHERE namespace = ${fixture.namespace} AND job_id = ${String(id)} AND event_type = ${type}
  `;
  return Number(found.count);
}

async function pendingRecords(fixture: Fixture): Promise<number> {
  const [found] = await fixture.sql<Array<{ count: number | string | bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM bunqueue_flow_failures AS failure
    WHERE failure.namespace = ${fixture.namespace}
      AND EXISTS (
        SELECT 1 FROM bunqueue_dependencies AS dependency
        WHERE dependency.namespace = failure.namespace
          AND dependency.job_id = failure.parent_id
          AND dependency.dependency_id = failure.child_id
      )
  `;
  return Number(found.count);
}

afterAll(async () => {
  if (!postgresUrl) return;
  for (const namespace of namespaces) await cleanupPostgresNamespace(postgresUrl, namespace);
});

describe('PostgreSQL recursive flow failure propagation durability', () => {
  test.skipIf(!postgresUrl)(
    'a crash after the first level leaves a pending record that a restart applies',
    async () => {
      const fixture = await start('fail');
      try {
        const [gp, mid, leaf] = await chain(fixture, [null, 'failParentOnFailure']);
        await failLeaf(fixture, leaf);
        expect((await row(fixture, mid)).state).toBe('failed');
        expect((await row(fixture, gp)).state).toBe('waiting-children');
        expect(await pendingRecords(fixture)).toBe(1);

        await fixture.manager.shutdownPostgres();
        await restart(fixture, 'fail');

        const parent = await row(fixture, gp);
        expect(parent.state).toBe('failed');
        expect(parent.error).toBe(`Child job ${mid} failed: Child job ${leaf} failed: boom`);
        expect(await events(fixture, gp, 'failed')).toBe(1);
        expect(await pendingRecords(fixture)).toBe(0);
      } finally {
        await stop(fixture);
      }
    },
    30_000
  );

  test.skipIf(!postgresUrl)(
    'a pending ignore record is not reported as ignored until it is applied',
    async () => {
      const fixture = await start('ignore');
      try {
        const [gp, mid, leaf] = await chain(fixture, [null, 'ignoreDependencyOnFailure']);
        await failLeaf(fixture, leaf);
        expect((await row(fixture, gp)).state).toBe('waiting-children');
        expect(await fixture.manager.getIgnoredChildrenFailures(gp)).toEqual({});

        await fixture.manager.shutdownPostgres();
        await restart(fixture, 'ignore');

        expect((await row(fixture, gp)).state).toBe('delayed');
        expect(await events(fixture, gp, 'retried')).toBe(1);
        const [value] = await fixture.sql<Array<{ child_id: string; error: string }>>`
          SELECT child_id, error FROM bunqueue_flow_failures
          WHERE namespace = ${fixture.namespace} AND parent_id = ${String(gp)}
        `;
        expect(value).toEqual({
          child_id: String(mid),
          error: `Child job ${leaf} failed: boom`,
        });
        expect(await pendingRecords(fixture)).toBe(0);
      } finally {
        await stop(fixture);
      }
    },
    30_000
  );

  test.skipIf(!postgresUrl)(
    'each committed level leaves the next record: a crash between levels two and three',
    async () => {
      const fixture = await start('deep');
      try {
        const fpof = 'failParentOnFailure' as const;
        const [root, l1, l2, leaf] = await chain(fixture, [null, fpof, fpof]);
        await failLeaf(fixture, leaf);
        expect((await row(fixture, l2)).state).toBe('failed');
        // Apply exactly one level by hand, then "crash" again before the next.
        await fixture.sql.begin((tx) =>
          applyPostgresFlowFailurePropagation(tx, fixture.live, { parentId: l1, childId: l2 })
        );
        expect((await row(fixture, l1)).state).toBe('failed');
        expect((await row(fixture, root)).state).toBe('waiting-children');
        expect(await pendingRecords(fixture)).toBe(1);

        await fixture.manager.shutdownPostgres();
        await restart(fixture, 'deep');

        expect((await row(fixture, root)).state).toBe('failed');
        for (const id of [root, l1, l2]) expect(await events(fixture, id, 'failed')).toBe(1);
      } finally {
        await stop(fixture);
      }
    },
    30_000
  );

  for (const policy of ['failParentOnFailure', 'ignoreDependencyOnFailure'] as const) {
    test.skipIf(!postgresUrl)(
      `concurrent brokers apply a pending ${policy} record exactly once`,
      async () => {
        const fixture = await start(`race-${policy}`);
        const pools = Array.from({ length: 6 }, () => new SQL(postgresUrl!, { max: 2 }));
        try {
          const [gp, , leaf] = await chain(fixture, [null, policy]);
          await failLeaf(fixture, leaf);
          expect(await pendingRecords(fixture)).toBe(1);

          await Promise.all(
            pools.map((pool) =>
              recoverPostgresFlowFailurePropagations({ ...fixture.live, sql: pool })
            )
          );

          const expected = policy === 'failParentOnFailure' ? 'failed' : 'delayed';
          expect((await row(fixture, gp)).state).toBe(expected);
          expect(await events(fixture, gp, 'failed')).toBe(
            policy === 'failParentOnFailure' ? 1 : 0
          );
          expect(await events(fixture, gp, 'retried')).toBe(
            policy === 'failParentOnFailure' ? 0 : 1
          );
          expect(await pendingRecords(fixture)).toBe(0);
          // A second sweep finds nothing to do.
          expect(await recoverPostgresFlowFailurePropagations(fixture.live)).toBe(0);
        } finally {
          await Promise.allSettled(pools.map((pool) => pool.close({ timeout: 5 })));
          await stop(fixture);
        }
      },
      30_000
    );
  }

  test.skipIf(!postgresUrl)(
    'a parent without a policy, or without a parent, leaves no record',
    async () => {
      const fixture = await start('none');
      try {
        const [gp, mid, leaf] = await chain(fixture, [null, null]);
        await failLeaf(fixture, leaf);
        expect((await row(fixture, mid)).state).toBe('failed');
        expect((await row(fixture, gp)).state).toBe('waiting-children');
        const [records] = await fixture.sql<Array<{ count: number | string | bigint }>>`
          SELECT COUNT(*)::bigint AS count FROM bunqueue_flow_failures
          WHERE namespace = ${fixture.namespace}
        `;
        expect(Number(records.count)).toBe(0);
        expect(await recoverPostgresFlowFailurePropagations(fixture.live)).toBe(0);
        expect((await row(fixture, gp)).state).toBe('waiting-children');
      } finally {
        await stop(fixture);
      }
    },
    30_000
  );
});
