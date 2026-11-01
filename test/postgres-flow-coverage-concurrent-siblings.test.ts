/**
 * Coverage (PostgreSQL, four broker processes): two siblings under one failParentOnFailure
 * middle node that fail at the same moment through different brokers.
 *
 * gp (queue A) <- mid (queue B, failParentOnFailure) <- [leaf1 (queue C1), leaf2 (queue C2)].
 * C1 is served only by a worker on broker 1 and C2 only by a worker on broker 2, so the
 * two siblings of every flow always fail through different brokers; a barrier holds every
 * leaf until all are active, then they throw together. Expected: mid and gp fail exactly
 * once (one DLQ entry, one `failed` event each), each leaf is in the DLQ exactly once,
 * no job stays in waiting-children, and gp never runs. The mixed case gives leaf1
 * ignoreDependencyOnFailure: mid still fails exactly once, because of leaf2, and a failed
 * mid reports no ignored failure.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import type { FlowJob, Queue } from '../src/client';
import { PostgresPublicApiHarness, waitFor } from './support/postgres-public-api-harness';
import { expectedPostgresVersionPrefix } from './support/postgres-version';

type LeafPolicy = 'failParentOnFailure' | 'ignoreDependencyOnFailure';

const FLOWS = 6;
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
  let state = '';
  await waitFor(
    `${id} to reach ${expected} (last ${state})`,
    async () => {
      state = await queue.getJobState(id);
      return state === expected;
    },
    30_000
  );
}

async function eventCount(id: string, type: string): Promise<number> {
  const [row] = await sql!<Array<{ count: number | string | bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM bunqueue_events
    WHERE namespace = ${fixture().namespace} AND job_id = ${id} AND event_type = ${type}
  `;
  return Number(row.count);
}

async function dlqIds(queue: Queue<unknown>): Promise<string[]> {
  return (await queue.getDlqAsync()).map((entry) => entry.job.id).sort();
}

function tree(names: Record<string, string>, index: number, leaf1Policy: LeafPolicy): FlowJob {
  return {
    name: 'gp',
    queueName: names.a,
    data: { index },
    children: [
      {
        name: 'mid',
        queueName: names.b,
        data: { index },
        opts: { failParentOnFailure: true },
        children: [
          {
            name: 'leaf1',
            queueName: names.c1,
            data: { index },
            opts: { [leaf1Policy]: true, attempts: 1 },
          },
          {
            name: 'leaf2',
            queueName: names.c2,
            data: { index },
            opts: { failParentOnFailure: true, attempts: 1 },
          },
        ],
      },
    ],
  };
}

async function run(leaf1Policy: LeafPolicy) {
  const current = fixture();
  const names = {
    a: current.unique('pg-sib-a'),
    b: current.unique('pg-sib-b'),
    c1: current.unique('pg-sib-c1'),
    c2: current.unique('pg-sib-c2'),
  };
  const queueA = current.queue<unknown>(names.a, 0);
  const queueB = current.queue<unknown>(names.b, 0);
  const queueC1 = current.queue<unknown>(names.c1, 0);
  const queueC2 = current.queue<unknown>(names.c2, 0);

  const ran: string[] = [];
  let arrived = 0;
  const allActive = Promise.withResolvers<void>();
  const leafProcessor = async (job: { name: string }) => {
    ran.push(job.name);
    if (++arrived === FLOWS * 2) allActive.resolve();
    await allActive.promise;
    throw new Error(`boom-${job.name}`);
  };
  current.worker<unknown, unknown>(names.c1, 1, leafProcessor, { concurrency: FLOWS });
  current.worker<unknown, unknown>(names.c2, 2, leafProcessor, { concurrency: FLOWS });
  for (const [name, broker] of [
    [names.a, 3],
    [names.b, 3],
  ] as const) {
    current.worker<unknown, unknown>(name, broker, async (job) => {
      ran.push(job.name);
      return null;
    });
  }

  const producer = current.flow(0);
  await producer.waitUntilReady();
  const nodes = await Promise.all(
    Array.from({ length: FLOWS }, (_, index) => producer.add(tree(names, index, leaf1Policy)))
  );
  const flows = nodes.map((node) => {
    const mid = node.children![0];
    return {
      gpId: node.job.id,
      midId: mid.job.id,
      leaf1Id: mid.children![0].job.id,
      leaf2Id: mid.children![1].job.id,
    };
  });
  for (const ids of flows) {
    // The sibling that lost the race may still be committing its own FAIL.
    await waitForState(queueA, ids.gpId, 'failed');
    await waitForState(queueB, ids.midId, 'failed');
    await waitForState(queueC1, ids.leaf1Id, 'failed');
    await waitForState(queueC2, ids.leaf2Id, 'failed');
  }
  // Let a late duplicate (another broker's applier or the recovery sweep) surface.
  await Bun.sleep(1_500);

  expect(await dlqIds(queueA)).toEqual(flows.map((ids) => ids.gpId).sort());
  expect(await dlqIds(queueB)).toEqual(flows.map((ids) => ids.midId).sort());
  expect(await dlqIds(queueC1)).toEqual(flows.map((ids) => ids.leaf1Id).sort());
  expect(await dlqIds(queueC2)).toEqual(flows.map((ids) => ids.leaf2Id).sort());
  for (const queue of [queueA, queueB, queueC1, queueC2]) {
    expect(await queue.getWaitingChildrenCount()).toBe(0);
  }
  for (const ids of flows) {
    for (const id of [ids.gpId, ids.midId, ids.leaf1Id, ids.leaf2Id]) {
      expect(await eventCount(id, 'failed')).toBe(1);
    }
  }
  expect(ran.filter((name) => name === 'gp' || name === 'mid')).toEqual([]);
  return { queueA, queueB, flows };
}

describe(`PostgreSQL ${expectedPostgresVersionPrefix} concurrent sibling failures`, () => {
  test.skipIf(!postgresUrl)(
    'two failParentOnFailure siblings failing on two brokers fail mid and gp exactly once',
    async () => {
      const { queueA, queueB, flows } = await run('failParentOnFailure');
      const dlqA = await queueA.getDlqAsync();
      const dlqB = await queueB.getDlqAsync();
      for (const ids of flows) {
        const midError = dlqB.find((entry) => entry.job.id === ids.midId)?.error ?? '';
        expect([
          `Child job ${ids.leaf1Id} failed: boom-leaf1`,
          `Child job ${ids.leaf2Id} failed: boom-leaf2`,
        ]).toContain(midError);
        expect(dlqA.find((entry) => entry.job.id === ids.gpId)?.error).toBe(
          `Child job ${ids.midId} failed: ${midError}`
        );
      }
    },
    120_000
  );

  test.skipIf(!postgresUrl)(
    'ignore + failParentOnFailure siblings failing on two brokers fail mid once, by leaf2',
    async () => {
      const { queueA, queueB, flows } = await run('ignoreDependencyOnFailure');
      const dlqA = await queueA.getDlqAsync();
      const dlqB = await queueB.getDlqAsync();
      for (const ids of flows) {
        const midError = `Child job ${ids.leaf2Id} failed: boom-leaf2`;
        expect(dlqB.find((entry) => entry.job.id === ids.midId)?.error).toBe(midError);
        expect(dlqA.find((entry) => entry.job.id === ids.gpId)?.error).toBe(
          `Child job ${ids.midId} failed: ${midError}`
        );
        const mid = await queueB.getJob(ids.midId);
        expect(mid).not.toBeNull();
        expect(await mid!.getIgnoredChildrenFailures()).toEqual({});
      }
    },
    120_000
  );
});
