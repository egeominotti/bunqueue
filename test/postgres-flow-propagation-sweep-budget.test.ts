/**
 * The PostgreSQL flow-failure recovery sweep is bounded per run (startup or one tick)
 * and continues across runs: each run reads at most `maxPages` pages, the next run
 * resumes after the last record it read, and past the end it wraps to the oldest
 * record, so a record behind the cursor is still reached.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { PostgresQueueManager } from '../src/application/postgresQueueManager';
import type { JobId } from '../src/domain/types/job';
import type { PostgresContext } from '../src/infrastructure/persistence/postgres/context';
import { recoverPostgresFlowFailurePropagations } from '../src/infrastructure/persistence/postgres/flowFailurePropagation';
import { failPostgresJob } from '../src/infrastructure/persistence/postgres/outcomes';
import { updatePostgresJobParent } from '../src/infrastructure/persistence/postgres/relationships';
import { cleanupPostgresNamespace, postgresRaceContext } from './support/postgres-event-race';

const postgresUrl = Bun.env.BUNQUEUE_TEST_POSTGRES_URL;
const namespaces: string[] = [];
const QUEUE = 'flow-propagation-budget';

afterAll(async () => {
  if (!postgresUrl) return;
  for (const namespace of namespaces) await cleanupPostgresNamespace(postgresUrl, namespace);
});

describe('PostgreSQL flow failure sweep budget', () => {
  test.skipIf(!postgresUrl)(
    'caps each run, continues from its cursor and wraps around to older records',
    async () => {
      const namespace = `test-flow-budget-${Date.now()}-${crypto.randomUUID()}`;
      namespaces.push(namespace);
      const manager = new PostgresQueueManager({
        postgres: { url: postgresUrl!, namespace, brokerId: 'budget' },
      });
      const sql = new SQL(postgresUrl!, { max: 2 });
      try {
        await manager.waitUntilReady();
        const live = postgresRaceContext(manager, sql);
        // Post-commit propagation is dropped: every chain stops with a pending record.
        const crashing: PostgresContext = {
          ...live,
          postCommitMaintenance: async (subsystem, operation) => {
            if (!subsystem.startsWith('flow-failure:')) await operation();
          },
        };

        /** gp <- mid(failParentOnFailure) <- leaf: mid failed, gp's record pending. */
        const pendingChain = async (): Promise<JobId> => {
          const gp = await manager.push(QUEUE, { data: {}, delay: 600_000 });
          const mid = await manager.push(QUEUE, {
            data: {},
            delay: 600_000,
            failParentOnFailure: true,
          });
          await updatePostgresJobParent(live, mid.id, gp.id);
          const leaf = await manager.push(QUEUE, {
            data: {},
            failParentOnFailure: true,
            maxAttempts: 1,
          });
          await updatePostgresJobParent(live, leaf.id, mid.id);
          const claim = await manager.pullWithLock(QUEUE, 'budget-worker');
          expect(claim.job?.id).toBe(leaf.id);
          await failPostgresJob(crashing, {
            id: leaf.id,
            token: claim.token!,
            error: 'boom',
            unrecoverable: true,
          });
          return gp.id;
        };

        const failedParents = async (ids: readonly JobId[]): Promise<boolean[]> => {
          const rows = await sql<Array<{ id: string; state: string }>>`
            SELECT id, state FROM bunqueue_jobs
            WHERE namespace = ${namespace} AND id = ANY(${sql.array(ids.map(String), 'TEXT')})
          `;
          const states = new Map(rows.map((row) => [row.id, row.state]));
          return ids.map((id) => states.get(String(id)) === 'failed');
        };

        for (let index = 0; index < 4; index++) await pendingChain();
        // The sweep's own order: (created_at, parent_id, child_id).
        const ordered = (
          await sql<Array<{ parent_id: string }>>`
            SELECT parent_id FROM bunqueue_flow_failures WHERE namespace = ${namespace}
            ORDER BY created_at, parent_id, child_id
          `
        ).map((row) => row.parent_id as JobId);
        expect(ordered).toHaveLength(4);

        // Two pages of one record: the first two records, in order.
        expect(await recoverPostgresFlowFailurePropagations(live, 1, 2)).toBe(2);
        expect(await failedParents(ordered)).toEqual([true, true, false, false]);

        // A record behind the cursor (the oldest of all) is not read on the next run.
        const behind = await pendingChain();
        await sql`
          UPDATE bunqueue_flow_failures SET created_at = 0
          WHERE namespace = ${namespace} AND parent_id = ${String(behind)}
        `;
        expect(await recoverPostgresFlowFailurePropagations(live, 1, 2)).toBe(2);
        expect(await failedParents([...ordered, behind])).toEqual([true, true, true, true, false]);

        // Past the end the run wraps to the oldest record and reaches it.
        expect(await recoverPostgresFlowFailurePropagations(live, 1, 2)).toBe(1);
        expect(await failedParents([behind])).toEqual([true]);

        // A full cycle with nothing left visits nothing and resets the cursor.
        expect(await recoverPostgresFlowFailurePropagations(live, 1, 2)).toBe(0);
        const [left] = await sql<Array<{ count: number | string | bigint }>>`
          SELECT COUNT(*)::bigint AS count FROM bunqueue_flow_failures
          WHERE namespace = ${namespace}
        `;
        expect(Number(left.count)).toBe(0);
      } finally {
        await Promise.allSettled([manager.shutdownPostgres(), sql.close({ timeout: 5 })]);
      }
    },
    30_000
  );
});
