/**
 * A propagated ignore/continue record that lands on a parent after its completion
 * cleared the parent's values (a sibling's continueParentOnFailure released it, it ran
 * and completed before the record committed) must not survive as a phantom value.
 * The state is constructed directly: a completed parent holding an edge-less record
 * from a failed child. An applied value on a live, non-completed parent must survive.
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
const QUEUE = 'flow-propagation-completed';

const VARIANTS = [
  { policy: 'ignoreDependencyOnFailure', read: 'getIgnoredChildrenFailures' },
  { policy: 'continueParentOnFailure', read: 'getFailedChildrenValues' },
] as const;

interface Fixture {
  readonly namespace: string;
  readonly manager: PostgresQueueManager;
  readonly sql: SQL;
  readonly ctx: PostgresContext;
}

async function withFixture(label: string, body: (fixture: Fixture) => Promise<void>) {
  const namespace = `test-flow-completed-${label}-${Date.now()}-${crypto.randomUUID()}`;
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

async function push(fixture: Fixture, input: Partial<JobInput> = {}): Promise<Job> {
  return await fixture.manager.push(QUEUE, { data: {}, delay: 600_000, ...input });
}

/** A parent whose failed child's policy was applied: the value row, no edge. */
async function parentWithValue(fixture: Fixture, policy: string): Promise<[Job, Job]> {
  const parent = await push(fixture);
  const sibling = await push(fixture);
  await updatePostgresJobParent(fixture.ctx, sibling.id, parent.id);
  const child = await fixture.manager.push(QUEUE, { data: {}, maxAttempts: 1, [policy]: true });
  const claim = await fixture.manager.pullWithLock(QUEUE, 'completed-worker');
  expect(claim.job?.id).toBe(child.id);
  await failPostgresJob(fixture.ctx, {
    id: child.id,
    token: claim.token!,
    error: 'boom',
    unrecoverable: true,
  });
  await updatePostgresJobParent(fixture.ctx, child.id, parent.id);
  return [parent, child];
}

async function records(fixture: Fixture, parentId: JobId): Promise<string[]> {
  const rows = await fixture.sql<Array<{ child_id: string }>>`
    SELECT child_id FROM bunqueue_flow_failures
    WHERE namespace = ${fixture.namespace} AND parent_id = ${String(parentId)}
  `;
  return rows.map((row) => row.child_id);
}

/** What the race leaves: the parent completed, its child's record still present. */
async function markCompleted(fixture: Fixture, id: JobId): Promise<void> {
  await fixture.sql`
    UPDATE bunqueue_jobs SET state = 'completed', completed_at = 1
    WHERE namespace = ${fixture.namespace} AND id = ${String(id)}
  `;
}

afterAll(async () => {
  if (!postgresUrl) return;
  for (const namespace of namespaces) await cleanupPostgresNamespace(postgresUrl, namespace);
});

describe('PostgreSQL propagated records on a completed parent', () => {
  for (const { policy, read } of VARIANTS) {
    test.skipIf(!postgresUrl)(
      `the sweep drops a ${policy} record on a completed parent, keeps a live one`,
      () =>
        withFixture(`sweep-${policy}`, async (fixture) => {
          const [completed, child] = await parentWithValue(fixture, policy);
          const [live, liveChild] = await parentWithValue(fixture, policy);
          expect(await records(fixture, completed.id)).toEqual([String(child.id)]);
          await markCompleted(fixture, completed.id);

          await recoverPostgresFlowFailurePropagations(fixture.ctx);

          expect(await records(fixture, completed.id)).toEqual([]);
          expect(await fixture.manager[read](completed.id)).toEqual({});
          expect(await records(fixture, live.id)).toEqual([String(liveChild.id)]);
          expect(Object.keys(await fixture.manager[read](live.id))).toHaveLength(1);
        }),
      30_000
    );

    test.skipIf(!postgresUrl)(
      `the applier drops a ${policy} record on a completed parent, keeps a live one`,
      () =>
        withFixture(`apply-${policy}`, async (fixture) => {
          const [completed, child] = await parentWithValue(fixture, policy);
          const [live, liveChild] = await parentWithValue(fixture, policy);
          await markCompleted(fixture, completed.id);

          for (const [parentId, childId] of [
            [completed.id, child.id],
            [live.id, liveChild.id],
          ]) {
            await fixture.sql.begin((tx) =>
              applyPostgresFlowFailurePropagation(tx, fixture.ctx, { parentId, childId })
            );
          }

          expect(await records(fixture, completed.id)).toEqual([]);
          expect(await fixture.manager[read](completed.id)).toEqual({});
          expect(await records(fixture, live.id)).toEqual([String(liveChild.id)]);
        }),
      30_000
    );
  }
});
