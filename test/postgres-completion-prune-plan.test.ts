import { afterAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { PostgresQueueManager } from '../src/application/postgresQueueManager';
import { prunePostgresCompletionTombstones } from '../src/infrastructure/persistence/postgres/completionLifecycle';
import { cleanupPostgresNamespace, postgresRaceContext } from './support/postgres-event-race';

const postgresUrl = Bun.env.BUNQUEUE_TEST_POSTGRES_URL;
const namespaces: string[] = [];
// 64 eight-leaf flows: 619 completions, 512 dependencies and 298 jobs. Before the fix the prune
// took 12.9-17.3 s here on PostgreSQL 16-18 (cubic in the namespace size); after it, ~15 ms.
const FLOWS = 64;
const LEAVES = 8;
const MAX_COMPLETED_JOBS = 5;
const PRUNE_BOUND_MS = 2_000;

interface Seed {
  readonly jobs: Array<{ id: string; state: string }>;
  readonly dependencies: Array<{ jobId: string; dependencyId: string }>;
  readonly completions: Array<{ jobId: string; completedAt: number }>;
}

/** Roots: f % 3 = 0 waits for its leaves, 1 was removed, 2 is retained; half the leaves remain. */
function seedRows(): Seed {
  const jobs: Seed['jobs'] = [];
  const dependencies: Seed['dependencies'] = [];
  const completionIds: string[] = [];
  for (let flow = 1; flow <= FLOWS; flow++) {
    const root = `r-${flow}`;
    if (flow % 3 === 0) jobs.push({ id: root, state: 'waiting-children' });
    if (flow % 3 === 2) jobs.push({ id: root, state: 'completed' });
    if (flow % 3 !== 0) completionIds.push(root);
    for (let leaf = 0; leaf < LEAVES; leaf++) {
      const id = `l-${flow}-${leaf}`;
      if ((flow + leaf) % 2 === 0) jobs.push({ id, state: 'completed' });
      dependencies.push({ jobId: root, dependencyId: id });
      completionIds.push(id);
    }
    completionIds.push(`x-${flow}`);
  }
  // Distinct, shuffled completion times keep the retention order independent of collation.
  const completions = completionIds.map((jobId, index) => ({
    jobId,
    completedAt: 1_000 + ((index * 7919) % completionIds.length),
  }));
  return { jobs, dependencies, completions };
}

/** The tombstones the prune must remove: unretained, unpinned, beyond the newest retained. */
function expectedRemoved(seed: Seed): string[] {
  const retained = new Set(seed.jobs.map((job) => job.id));
  const live = new Set(seed.jobs.filter((job) => job.state !== 'completed').map((job) => job.id));
  const pinned = new Set(
    seed.dependencies.filter((edge) => live.has(edge.jobId)).map((edge) => edge.dependencyId)
  );
  return seed.completions
    .filter((completion) => !retained.has(completion.jobId) && !pinned.has(completion.jobId))
    .sort((left, right) => right.completedAt - left.completedAt)
    .slice(MAX_COMPLETED_JOBS)
    .map((completion) => completion.jobId)
    .sort();
}

async function insertSeed(sql: SQL, namespace: string, seed: Seed): Promise<void> {
  await sql`
    INSERT INTO bunqueue_jobs
      (namespace, id, queue, payload, state, run_at, created_at, completed_at)
    SELECT ${namespace}, id, 'prune-plan', '\\x00'::bytea, state, 0, 0, 1
    FROM unnest(
      ${sql.array(
        seed.jobs.map((job) => job.id),
        'TEXT'
      )},
      ${sql.array(
        seed.jobs.map((job) => job.state),
        'TEXT'
      )}
    ) AS seeded(id, state)
  `;
  await sql`
    INSERT INTO bunqueue_dependencies (namespace, job_id, dependency_id)
    SELECT ${namespace}, job_id, dependency_id
    FROM unnest(
      ${sql.array(
        seed.dependencies.map((edge) => edge.jobId),
        'TEXT'
      )},
      ${sql.array(
        seed.dependencies.map((edge) => edge.dependencyId),
        'TEXT'
      )}
    ) AS seeded(job_id, dependency_id)
  `;
  await sql`
    INSERT INTO bunqueue_completions (namespace, job_id, queue, completed_at)
    SELECT ${namespace}, job_id, 'prune-plan', completed_at::bigint
    FROM unnest(
      ${sql.array(
        seed.completions.map((completion) => completion.jobId),
        'TEXT'
      )},
      ${sql.array(
        seed.completions.map((completion) => String(completion.completedAt)),
        'TEXT'
      )}
    ) AS seeded(job_id, completed_at)
  `;
}

afterAll(async () => {
  if (!postgresUrl) return;
  for (const value of namespaces) await cleanupPostgresNamespace(postgresUrl, value);
});

describe('PostgreSQL completion-retention prune plan', () => {
  test.skipIf(!postgresUrl)(
    'prunes a namespace the planner statistics do not cover in bounded time',
    async () => {
      const namespace = `test-completion-prune-plan-${Date.now()}-${crypto.randomUUID()}`;
      namespaces.push(namespace);
      const manager = new PostgresQueueManager({
        maxCompletedJobs: MAX_COMPLETED_JOBS,
        postgres: { url: postgresUrl!, namespace, brokerId: 'prune-plan', pollIntervalMs: 25 },
      });
      const sql = new SQL(postgresUrl!, { max: 1 });
      try {
        await manager.waitUntilReady();
        const ctx = postgresRaceContext(manager, sql);
        await manager.shutdownPostgres();
        const seed = seedRows();
        // Statistics taken before the namespace has rows estimate it at about one row,
        // as for a fresh namespace before autovacuum analyzes it.
        await sql`ANALYZE bunqueue_jobs, bunqueue_dependencies, bunqueue_completions`;
        await insertSeed(sql, namespace, seed);
        const expected = expectedRemoved(seed);

        const started = performance.now();
        const removed = await prunePostgresCompletionTombstones(ctx);
        const elapsedMs = performance.now() - started;

        const remaining = await sql<{ job_id: string }[]>`
          SELECT job_id FROM bunqueue_completions WHERE namespace = ${namespace}
        `;
        const remainingIds = new Set(remaining.map((row) => row.job_id));
        const removedIds = seed.completions
          .map((completion) => completion.jobId)
          .filter((id) => !remainingIds.has(id))
          .sort();
        expect(expected.length).toBeGreaterThan(0);
        expect(removed).toBe(expected.length);
        expect(removedIds).toEqual(expected);
        expect(elapsedMs).toBeLessThan(PRUNE_BOUND_MS);
      } finally {
        await Promise.allSettled([manager.shutdownPostgres(), sql.close({ timeout: 5 })]);
      }
    },
    180_000
  );
});
