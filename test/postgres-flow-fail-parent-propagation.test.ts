/**
 * PostgreSQL parity for recursive flow failure propagation: a parent that a child's
 * failParentOnFailure moves to `failed` has failed terminally too, so its own policy
 * must apply to its parent (the SQLite engine does this; see
 * test/repro-flow-fail-parent-propagation.test.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
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

async function waitForState(
  queue: Queue<unknown>,
  id: string,
  matches: (state: string) => boolean,
  timeoutMs = 20_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let state = await queue.getJobState(id);
  while (!matches(state) && Date.now() < deadline) {
    await Bun.sleep(50);
    state = await queue.getJobState(id);
  }
  return state;
}

/** gp <- mid(midPolicy) <- leaf(failParentOnFailure, fails) + a delayed sibling. */
async function run(midPolicy: Policy | null) {
  const current = fixture();
  const name = current.unique('pg-fpof');
  const queue = current.queue<unknown>(name, 0);
  const ran: string[] = [];
  current.worker<unknown, unknown>(name, 1, async (job) => {
    ran.push(job.name);
    if (job.name === 'leaf') throw new Error('boom');
    return { ok: job.name };
  });
  const producer = current.flow(2);
  await producer.waitUntilReady();
  const node = await producer.add({
    name: 'gp',
    queueName: name,
    data: {},
    children: [
      {
        name: 'mid',
        queueName: name,
        data: {},
        opts: midPolicy ? { [midPolicy]: true } : {},
        children: [
          {
            name: 'leaf',
            queueName: name,
            data: {},
            opts: { failParentOnFailure: true, attempts: 1 },
          },
          { name: 'sibling', queueName: name, data: {}, opts: { delay: 600_000 } },
        ],
      },
    ],
  });
  const mid = node.children![0];
  expect(await waitForState(queue, mid.children![0].job.id, (s) => s === 'failed')).toBe('failed');
  expect(await waitForState(queue, mid.job.id, (s) => s === 'failed')).toBe('failed');
  return { queue, gpId: node.job.id, ran };
}

describe(`PostgreSQL ${expectedPostgresVersionPrefix} recursive flow failure propagation`, () => {
  test.skipIf(!postgresUrl)(
    'failParentOnFailure on the middle node fails the grandparent',
    async () => {
      const { queue, gpId, ran } = await run('failParentOnFailure');
      expect(await waitForState(queue, gpId, (s) => s === 'failed')).toBe('failed');
      expect(ran).not.toContain('gp');
    },
    60_000
  );

  for (const policy of [
    'ignoreDependencyOnFailure',
    'removeDependencyOnFailure',
    'continueParentOnFailure',
  ] as const) {
    test.skipIf(!postgresUrl)(
      `${policy} on the middle node releases the grandparent`,
      async () => {
        const { queue, gpId, ran } = await run(policy);
        expect(await waitForState(queue, gpId, (s) => s === 'completed')).toBe('completed');
        expect(ran).toContain('gp');
      },
      60_000
    );
  }

  test.skipIf(!postgresUrl)(
    'control: without a policy the grandparent keeps waiting',
    async () => {
      const { queue, gpId } = await run(null);
      await Bun.sleep(1_000);
      expect(await queue.getJobState(gpId)).toBe('waiting-children');
    },
    60_000
  );

  test.skipIf(!postgresUrl)(
    'failParentOnFailure propagates through four levels',
    async () => {
      const current = fixture();
      const name = current.unique('pg-fpof-deep');
      const queue = current.queue<unknown>(name, 0);
      current.worker<unknown, unknown>(name, 1, async (job) => {
        if (job.name === 'leaf') throw new Error('boom');
        return null;
      });
      const producer = current.flow(2);
      await producer.waitUntilReady();
      const fpof = { failParentOnFailure: true };
      const node = await producer.add({
        name: 'root',
        queueName: name,
        data: {},
        children: [
          {
            name: 'l1',
            queueName: name,
            data: {},
            opts: fpof,
            children: [
              {
                name: 'l2',
                queueName: name,
                data: {},
                opts: fpof,
                children: [
                  { name: 'leaf', queueName: name, data: {}, opts: { ...fpof, attempts: 1 } },
                ],
              },
            ],
          },
        ],
      });
      expect(await waitForState(queue, node.job.id, (s) => s === 'failed')).toBe('failed');
    },
    60_000
  );
});
