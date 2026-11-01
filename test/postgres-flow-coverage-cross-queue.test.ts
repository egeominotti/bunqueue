/**
 * Coverage (PostgreSQL, four broker processes): failParentOnFailure propagation when
 * every level lives on a different queue served by a different broker.
 *
 * gp (queue A) <- mid (queue B, each policy) <- leaf (queue C, failParentOnFailure), with
 * the producer, each queue's worker and the reading client on different brokers. The
 * outcomes match the single-queue suite (test/postgres-flow-fail-parent-propagation):
 * failParentOnFailure fails gp, ignore/remove/continue release it, no policy keeps it in
 * waiting-children. Each DLQ holds its job exactly once with the chained error, and each
 * failed job has exactly one `failed` event. A four-level chain over four queues fails
 * every level.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import type { Queue } from '../src/client';
import { PostgresPublicApiHarness } from './support/postgres-public-api-harness';
import { expectedPostgresVersionPrefix } from './support/postgres-version';

type Policy =
  | 'failParentOnFailure'
  | 'ignoreDependencyOnFailure'
  | 'removeDependencyOnFailure'
  | 'continueParentOnFailure';

const postgresUrl = Bun.env.BUNQUEUE_TEST_POSTGRES_URL;
let harness: PostgresPublicApiHarness | null = null;
let sql: SQL | null = null;

beforeAll(async () => {
  if (!postgresUrl) return;
  harness = await PostgresPublicApiHarness.start(postgresUrl, expectedPostgresVersionPrefix);
  sql = new SQL(postgresUrl, { max: 2 });
});

afterEach(async () => {
  await harness?.closeClients();
});

afterAll(async () => {
  await sql?.close({ timeout: 5 });
  sql = null;
  await harness?.close();
  harness = null;
});

function fixture(): PostgresPublicApiHarness {
  if (!harness) throw new Error('PostgreSQL public API harness is not running');
  return harness;
}

async function waitForState(queue: Queue<unknown>, id: string, expected: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let state: string = await queue.getJobState(id);
  while (state !== expected && Date.now() < deadline) {
    await Bun.sleep(50);
    state = await queue.getJobState(id);
  }
  expect(state).toBe(expected);
}

async function eventCount(id: string, type: string): Promise<number> {
  const [row] = await sql!<Array<{ count: number | string | bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM bunqueue_events
    WHERE namespace = ${fixture().namespace} AND job_id = ${id} AND event_type = ${type}
  `;
  return Number(row.count);
}

async function expectDlq(
  queue: Queue<unknown>,
  expected: Array<{ id: string; error: string }>
): Promise<void> {
  const entries = await queue.getDlqAsync();
  expect(entries.map((entry) => entry.job.id).sort()).toEqual(
    expected.map((item) => item.id).sort()
  );
  for (const item of expected) {
    expect(entries.find((entry) => entry.job.id === item.id)?.error).toBe(item.error);
  }
}

/** Queue i is read from broker 0 and served by a worker on broker (i % 3) + 1. */
function openLevels(labels: string[], ran: string[]) {
  const current = fixture();
  const names = labels.map((label) => current.unique(label));
  const queues = names.map((name) => current.queue<unknown>(name, 0));
  names.forEach((name, index) => {
    current.worker<unknown, unknown>(name, (index % 3) + 1, async (job) => {
      ran.push(job.name);
      if (job.name === 'leaf') throw new Error('boom');
      return { ok: job.name };
    });
  });
  return { names, queues };
}

async function run(midPolicy: Policy | null) {
  const ran: string[] = [];
  const { names, queues } = openLevels(['pg-xq-a', 'pg-xq-b', 'pg-xq-c'], ran);
  const [queueA, queueB, queueC] = queues;
  const producer = fixture().flow(2);
  await producer.waitUntilReady();
  const node = await producer.add({
    name: 'gp',
    queueName: names[0],
    data: {},
    children: [
      {
        name: 'mid',
        queueName: names[1],
        data: {},
        opts: midPolicy ? { [midPolicy]: true } : {},
        children: [
          {
            name: 'leaf',
            queueName: names[2],
            data: {},
            opts: { failParentOnFailure: true, attempts: 1 },
          },
          { name: 'sibling', queueName: names[2], data: {}, opts: { delay: 600_000 } },
        ],
      },
    ],
  });
  const mid = node.children![0];
  const leafId = mid.children![0].job.id;
  await waitForState(queueC, leafId, 'failed');
  await waitForState(queueB, mid.job.id, 'failed');
  const midError = `Child job ${leafId} failed: boom`;
  await expectDlq(queueC, [{ id: leafId, error: 'boom' }]);
  await expectDlq(queueB, [{ id: mid.job.id, error: midError }]);
  expect(await eventCount(leafId, 'failed')).toBe(1);
  expect(await eventCount(mid.job.id, 'failed')).toBe(1);
  return { queueA, gpId: node.job.id, midId: mid.job.id, midError, ran };
}

describe(`PostgreSQL ${expectedPostgresVersionPrefix} cross-queue flow failure propagation`, () => {
  test.skipIf(!postgresUrl)(
    'failParentOnFailure on the middle node fails the grandparent on another queue',
    async () => {
      const { queueA, gpId, midId, midError, ran } = await run('failParentOnFailure');
      await waitForState(queueA, gpId, 'failed');
      await expectDlq(queueA, [{ id: gpId, error: `Child job ${midId} failed: ${midError}` }]);
      expect(await eventCount(gpId, 'failed')).toBe(1);
      expect(ran).not.toContain('gp');
    },
    90_000
  );

  for (const policy of [
    'ignoreDependencyOnFailure',
    'removeDependencyOnFailure',
    'continueParentOnFailure',
  ] as const) {
    test.skipIf(!postgresUrl)(
      `${policy} on the middle node releases the grandparent on another queue`,
      async () => {
        const { queueA, gpId, ran } = await run(policy);
        await waitForState(queueA, gpId, 'completed');
        expect(ran.filter((name) => name === 'gp')).toHaveLength(1);
        await expectDlq(queueA, []);
        expect(await eventCount(gpId, 'failed')).toBe(0);
      },
      90_000
    );
  }

  test.skipIf(!postgresUrl)(
    'control: without a policy on the middle node the grandparent keeps waiting',
    async () => {
      const { queueA, gpId, ran } = await run(null);
      await Bun.sleep(1_000);
      expect(await queueA.getJobState(gpId)).toBe('waiting-children');
      expect(ran).not.toContain('gp');
      await expectDlq(queueA, []);
    },
    90_000
  );

  test.skipIf(!postgresUrl)(
    'failParentOnFailure propagates through four levels on four queues',
    async () => {
      const ran: string[] = [];
      const { names, queues } = openLevels(
        ['pg-xq4-root', 'pg-xq4-l1', 'pg-xq4-l2', 'pg-xq4-leaf'],
        ran
      );
      const producer = fixture().flow(0);
      await producer.waitUntilReady();
      const fpof = { failParentOnFailure: true };
      const node = await producer.add({
        name: 'root',
        queueName: names[0],
        data: {},
        children: [
          {
            name: 'l1',
            queueName: names[1],
            data: {},
            opts: fpof,
            children: [
              {
                name: 'l2',
                queueName: names[2],
                data: {},
                opts: fpof,
                children: [
                  { name: 'leaf', queueName: names[3], data: {}, opts: { ...fpof, attempts: 1 } },
                ],
              },
            ],
          },
        ],
      });
      const l1 = node.children![0];
      const l2 = l1.children![0];
      const chain = [node.job.id, l1.job.id, l2.job.id, l2.children![0].job.id];
      await waitForState(queues[0], node.job.id, 'failed');
      let error = 'boom';
      for (let level = chain.length - 1; level >= 0; level--) {
        expect(await queues[level].getJobState(chain[level])).toBe('failed');
        await expectDlq(queues[level], [{ id: chain[level], error }]);
        expect(await eventCount(chain[level], 'failed')).toBe(1);
        error = `Child job ${chain[level]} failed: ${error}`;
      }
      expect(ran).toEqual(['leaf']);
    },
    90_000
  );
});
