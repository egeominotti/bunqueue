/**
 * A propagated ignore/continue record must never be kept for a parent it was not
 * applied to. gp{q: failParentOnFailure fails first, p: <policy>{c: failParentOnFailure
 * fails later}}: q fails gp; when c later fails p, p's own record toward gp must not
 * survive on the already-failed gp (SQLite returns early for a parent that is no longer
 * queued, and PostgreSQL before recursive propagation wrote no such record).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import type { Queue } from '../src/client';
import { PostgresPublicApiHarness } from './support/postgres-public-api-harness';
import { expectedPostgresVersionPrefix } from './support/postgres-version';

const postgresUrl = Bun.env.BUNQUEUE_TEST_POSTGRES_URL;
let harness: PostgresPublicApiHarness | null = null;

beforeAll(async () => {
  if (!postgresUrl) return;
  harness = await PostgresPublicApiHarness.start(postgresUrl, expectedPostgresVersionPrefix);
});

afterEach(async () => {
  await harness?.closeClients();
});

afterAll(async () => {
  await harness?.close();
  harness = null;
});

function fixture(): PostgresPublicApiHarness {
  if (!harness) throw new Error('PostgreSQL public API harness is not running');
  return harness;
}

async function waitForState(queue: Queue<unknown>, id: string, state: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  let current = await queue.getJobState(id);
  while (current !== state && Date.now() < deadline) {
    await Bun.sleep(50);
    current = await queue.getJobState(id);
  }
  return current;
}

const VARIANTS = [
  { policy: 'ignoreDependencyOnFailure', read: 'getIgnoredChildrenFailures' },
  { policy: 'continueParentOnFailure', read: 'getFailedChildrenValues' },
] as const;

describe(`PostgreSQL ${expectedPostgresVersionPrefix} propagated flow records`, () => {
  for (const { policy, read } of VARIANTS) {
    test.skipIf(!postgresUrl)(
      `${policy} on a child of an already-failed parent leaves no record`,
      async () => {
        const current = fixture();
        const name = current.unique('pg-stale');
        const queue = current.queue<unknown>(name, 0);
        current.worker<unknown, unknown>(name, 1, async (job) => {
          if (job.name === 'q' || job.name === 'c') throw new Error(`boom-${job.name}`);
          return null;
        });
        const producer = current.flow(2);
        await producer.waitUntilReady();
        const node = await producer.add({
          name: 'gp',
          queueName: name,
          data: {},
          children: [
            {
              name: 'q',
              queueName: name,
              data: {},
              opts: { failParentOnFailure: true, attempts: 1 },
            },
            {
              name: 'p',
              queueName: name,
              data: {},
              opts: { [policy]: true },
              children: [
                {
                  name: 'c',
                  queueName: name,
                  data: {},
                  opts: { failParentOnFailure: true, attempts: 1, delay: 2_500 },
                },
              ],
            },
          ],
        });
        const gpId = node.job.id;
        const pId = node.children!.find((child) => child.job.name === 'p')!.job.id;
        expect(await waitForState(queue, gpId, 'failed')).toBe('failed');
        expect(await waitForState(queue, pId, 'failed')).toBe('failed');
        await Bun.sleep(1_500);

        const sql = new SQL(postgresUrl!, { max: 1 });
        try {
          const rows = await sql`
            SELECT child_id, mode FROM bunqueue_flow_failures
            WHERE namespace = ${current.namespace} AND parent_id = ${String(gpId)}
          `;
          expect(rows).toEqual([]);
        } finally {
          await sql.close();
        }
        const gp = await queue.getJob(String(gpId));
        expect(gp).not.toBeNull();
        expect(await gp![read]()).toEqual({});
      },
      60_000
    );
  }
});
