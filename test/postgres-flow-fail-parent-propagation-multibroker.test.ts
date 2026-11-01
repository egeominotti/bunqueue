/**
 * PostgreSQL recursive flow-failure propagation across four broker processes: sibling
 * chains that race to fail (or release) one grandparent apply it exactly once, and a
 * SIGKILLed broker holding the leaf's lease is finished by the survivors' recovery,
 * which propagates the chain level by level.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import type { FlowJob, Queue } from '../src/client';
import { PostgresPublicApiHarness } from './support/postgres-public-api-harness';
import { expectedPostgresVersionPrefix } from './support/postgres-version';

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

async function waitForState(
  queue: Queue<unknown>,
  id: string,
  expected: string,
  timeoutMs = 30_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let state = await queue.getJobState(id);
  while (state !== expected && Date.now() < deadline) {
    await Bun.sleep(50);
    state = await queue.getJobState(id);
  }
  return state;
}

async function eventCount(id: string, type: string): Promise<number> {
  const [row] = await sql!<Array<{ count: number | string | bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM bunqueue_events
    WHERE namespace = ${fixture().namespace} AND job_id = ${id} AND event_type = ${type}
  `;
  return Number(row.count);
}

/** gp <- midA(policy) <- leafA, gp <- midB(policy) <- leafB; both leaves fail. */
function siblingChains(name: string, flow: number, policy: string): FlowJob {
  const branch = (side: string): FlowJob => ({
    name: `mid-${side}`,
    queueName: name,
    data: { flow },
    opts: { [policy]: true },
    children: [
      {
        name: 'leaf',
        queueName: name,
        data: { flow },
        opts: { failParentOnFailure: true, attempts: 1 },
      },
    ],
  });
  return { name: 'gp', queueName: name, data: { flow }, children: [branch('a'), branch('b')] };
}

describe(`PostgreSQL ${expectedPostgresVersionPrefix} multi-broker flow failure propagation`, () => {
  test.skipIf(!postgresUrl)(
    'sibling chains racing on four brokers fail each grandparent exactly once',
    async () => {
      const current = fixture();
      const name = current.unique('pg-fpof-race');
      const queue = current.queue<unknown>(name, 0);
      const ran: string[] = [];
      for (const broker of [1, 2, 3]) {
        current.worker<unknown, unknown>(name, broker, async (job) => {
          ran.push(job.name);
          if (job.name === 'leaf') throw new Error('boom');
          return null;
        });
      }
      const producer = current.flow(0);
      await producer.waitUntilReady();
      const flows = await Promise.all(
        Array.from({ length: 8 }, (_, flow) =>
          producer.add(siblingChains(name, flow, 'failParentOnFailure'))
        )
      );
      for (const node of flows) {
        expect(await waitForState(queue, node.job.id, 'failed')).toBe('failed');
        for (const mid of node.children!) {
          expect(await waitForState(queue, mid.job.id, 'failed')).toBe('failed');
        }
      }
      for (const node of flows) expect(await eventCount(node.job.id, 'failed')).toBe(1);
      expect(ran).not.toContain('gp');
    },
    120_000
  );

  test.skipIf(!postgresUrl)(
    'sibling ignore chains racing on four brokers release each grandparent exactly once',
    async () => {
      const current = fixture();
      const name = current.unique('pg-ignore-race');
      const queue = current.queue<unknown>(name, 0);
      const ran: string[] = [];
      for (const broker of [1, 2, 3]) {
        current.worker<unknown, unknown>(name, broker, async (job) => {
          ran.push(job.name);
          if (job.name === 'leaf') throw new Error('boom');
          return null;
        });
      }
      const producer = current.flow(0);
      await producer.waitUntilReady();
      const flows = await Promise.all(
        Array.from({ length: 8 }, (_, flow) =>
          producer.add(siblingChains(name, flow, 'ignoreDependencyOnFailure'))
        )
      );
      for (const node of flows) {
        expect(await waitForState(queue, node.job.id, 'completed')).toBe('completed');
        expect(await eventCount(node.job.id, 'retried')).toBe(1);
      }
      expect(ran.filter((job) => job === 'gp')).toHaveLength(8);
    },
    120_000
  );

  // Last in the file: the SIGKILLed broker does not come back.
  test.skipIf(!postgresUrl)(
    'a SIGKILLed broker holding the leaf is finished by the survivors through every level',
    async () => {
      const current = fixture();
      const name = current.unique('pg-fpof-crash');
      const queue = current.queue<unknown>(name, 0);
      const started = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const victim = current.worker<unknown, unknown>(
        name,
        3,
        async () => {
          started.resolve(undefined);
          await release.promise;
          return null;
        },
        { concurrency: 1, heartbeatInterval: 100, lockDuration: 750 }
      );
      victim.on('error', () => {});
      await victim.waitUntilReady();
      const fpof = { failParentOnFailure: true };
      const producer = current.flow(0);
      await producer.waitUntilReady();
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
      await started.promise;
      await current.crashBroker(3);

      const l1 = node.children![0];
      const l2 = l1.children![0];
      const leaf = l2.children![0];
      expect(await waitForState(queue, node.job.id, 'failed')).toBe('failed');
      for (const id of [leaf.job.id, l2.job.id, l1.job.id, node.job.id]) {
        expect(await queue.getJobState(id)).toBe('failed');
        expect(await eventCount(id, 'failed')).toBe(1);
      }
      release.resolve(undefined);
      // The victim's client waits out its command timeout against the dead broker.
      await victim.close(true);
    },
    120_000
  );
});
