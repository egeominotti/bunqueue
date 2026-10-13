/**
 * Issue #155 B on PostgreSQL: `cancel()` removes a completed job.
 *
 * `cancelPostgresJob` cancelled only pending rows, so a completed job kept its payload,
 * its result and its logs. It now leaves the state of a removeOnComplete completion,
 * except that the result does not survive either: the row and its logs are deleted, and
 * the completion tombstone stays as payload-free dependency evidence (original
 * completion time, result cleared), so dependents keep resolving.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { PostgresQueueManager } from '../src/application/postgresQueueManager';
import type { JobId } from '../src/domain/types/job';
import type { JobEvent } from '../src/domain/types/queue';
import { decodePostgresEvent } from '../src/infrastructure/persistence/postgres/codec';
import { cleanupPostgresNamespace, eventually } from './support/postgres-event-race';

const postgresUrl = Bun.env.BUNQUEUE_TEST_POSTGRES_URL;
const namespaces: string[] = [];

function broker(label: string, brokerId: string, value?: string): PostgresQueueManager {
  const ns = value ?? `test-cancel-completed-${label}-${Date.now()}-${crypto.randomUUID()}`;
  if (!value) namespaces.push(ns);
  return new PostgresQueueManager({
    postgres: { url: postgresUrl!, namespace: ns, brokerId, pollIntervalMs: 25 },
  });
}

async function complete(manager: PostgresQueueManager, queue: string, result: unknown) {
  const job = await manager.push(queue, { data: { secret: 'payload' } });
  const claimed = await manager.pullWithLock(queue, 'cancel-worker');
  expect(claimed.job?.id).toBe(job.id);
  await manager.ack(job.id, result, claimed.token!);
  return job.id;
}

async function rows(namespace: string, id: JobId) {
  const sql = new SQL(postgresUrl!, { max: 1 });
  try {
    const [jobs] = await sql`
      SELECT COUNT(*)::int AS n FROM bunqueue_jobs WHERE namespace = ${namespace} AND id = ${id}
    `;
    const [logs] = await sql`
      SELECT COUNT(*)::int AS n FROM bunqueue_job_logs
      WHERE namespace = ${namespace} AND job_id = ${id}
    `;
    const completions = await sql`
      SELECT completed_at, result FROM bunqueue_completions
      WHERE namespace = ${namespace} AND job_id = ${id}
    `;
    return {
      jobs: jobs.n as number,
      logs: logs.n as number,
      completion: completions[0]
        ? { completedAt: Number(completions[0].completed_at), result: completions[0].result }
        : null,
    };
  } finally {
    await sql.close();
  }
}

/** The newest `bunqueue_events` row recorded for `id`, as stored. */
async function latestEventRow(namespace: string, id: JobId) {
  const sql = new SQL(postgresUrl!, { max: 1 });
  try {
    const [row] = await sql`
      SELECT id, queue, event_type, job_id, occurred_at, payload FROM bunqueue_events
      WHERE namespace = ${namespace} AND job_id = ${id}
      ORDER BY id DESC LIMIT 1
    `;
    return row as Parameters<typeof decodePostgresEvent>[0];
  } finally {
    await sql.close();
  }
}

afterAll(async () => {
  if (!postgresUrl) return;
  for (const value of namespaces) await cleanupPostgresNamespace(postgresUrl, value);
});

describe('PostgreSQL cancel of a completed job', () => {
  test.skipIf(!postgresUrl)(
    'removes the row, logs and result, keeps a payload-free tombstone',
    async () => {
      const first = broker('tombstone', 'cancel-a');
      const namespace = namespaces.at(-1)!;
      const second = broker('tombstone', 'cancel-b', namespace);
      try {
        await Promise.all([first.waitUntilReady(), second.waitUntilReady()]);
        const id = await complete(first, 'cancel-completed', { answer: 4 });
        await first.addLogDurable(id, 'completed line');
        const completedAt = (await first.getJob(id))!.completedAt!;
        expect((await rows(namespace, id)).logs).toBe(1);

        expect(await first.cancel(id)).toBe(true);

        expect(await rows(namespace, id)).toEqual({
          jobs: 0,
          logs: 0,
          completion: { completedAt, result: null },
        });
        expect(await first.getJobState(id)).toBe('unknown');
        expect(await first.getJob(id)).toBeNull();
        expect(first.getResult(id)).toBeUndefined();
        expect(await first.getCompletionAsync(id)).toEqual({ found: true, result: undefined });
        expect(first.getQueueJobCounts('cancel-completed').completed).toBe(0);
        expect(await second.getJobState(id)).toBe('unknown');
        expect(await eventually(() => second.getResult(id) === undefined)).toBe(true);
        expect(await first.cancel(id)).toBe(false);

        const dependent = await second.push('cancel-dependent', { data: {}, dependsOn: [id] });
        expect(await second.getJobState(dependent.id)).toBe('waiting');
      } finally {
        await Promise.allSettled([first.shutdownPostgres(), second.shutdownPostgres()]);
      }
    }
  );

  test.skipIf(!postgresUrl)(
    'the removed event carries no job data and every broker still applies it',
    async () => {
      const first = broker('event', 'cancel-event-a');
      const namespace = namespaces.at(-1)!;
      const second = broker('event', 'cancel-event-b', namespace);
      const broadcast: JobEvent[] = [];
      const unsubscribe = second.subscribe((event) => broadcast.push(event));
      try {
        await Promise.all([first.waitUntilReady(), second.waitUntilReady()]);
        const id = await complete(first, 'cancel-event', { answer: 4 });
        expect(await eventually(() => second.getJobIndex().get(id)?.type === 'completed')).toBe(
          true
        );

        expect(await first.cancel(id)).toBe(true);

        const row = await latestEventRow(namespace, id);
        expect(Buffer.from(row.payload!).includes('secret')).toBe(false);
        expect(decodePostgresEvent(row)).toMatchObject({
          type: 'removed',
          jobId: id,
          queue: 'cancel-event',
          job: null,
          state: 'completed',
          removed: true,
        });
        expect(await eventually(() => !second.getJobIndex().has(id))).toBe(true);
        expect(second.getQueueJobCounts('cancel-event').completed).toBe(0);
        expect(second.getResult(id)).toBeUndefined();
        expect(
          await eventually(() =>
            broadcast.some((event) => event.eventType === 'removed' && event.jobId === id)
          )
        ).toBe(true);
      } finally {
        unsubscribe();
        await Promise.allSettled([first.shutdownPostgres(), second.shutdownPostgres()]);
      }
    }
  );

  test.skipIf(!postgresUrl)('a waiting parent still resolves without the child value', async () => {
    const manager = broker('flow', 'cancel-flow');
    try {
      await manager.waitUntilReady();
      const removed = await manager.push('cancel-children', { data: {} });
      const kept = await manager.push('cancel-children', { data: {} });
      const children = [removed.id, kept.id];
      const parent = await manager.push('cancel-parent', {
        data: {},
        dependsOn: children,
        childrenIds: children,
      });
      for (const [index, id] of children.entries()) {
        const claimed = await manager.pullWithLock('cancel-children', 'flow-worker');
        expect(claimed.job?.id).toBe(id);
        if (index === 0) {
          await manager.ack(id, { value: 'removed' }, claimed.token!);
          expect(await manager.cancel(id)).toBe(true);
          expect(await manager.getJobState(parent.id)).toBe('waiting-children');
        } else {
          await manager.ack(id, { value: 'kept' }, claimed.token!);
        }
      }

      expect(
        await eventually(async () => (await manager.getJobState(parent.id)) === 'waiting')
      ).toBe(true);
      expect(await manager.getChildrenValues(parent.id)).toEqual({
        [`cancel-children:${kept.id}`]: { value: 'kept' },
      });
    } finally {
      await manager.shutdownPostgres();
    }
  });

  test.skipIf(!postgresUrl)('active and failed jobs are not removed', async () => {
    const manager = broker('refusals', 'cancel-refusals');
    try {
      await manager.waitUntilReady();
      const failed = await manager.push('cancel-refusals', { data: {}, maxAttempts: 1 });
      const failedClaim = await manager.pullWithLock('cancel-refusals', 'refusal-worker');
      await manager.fail(failed.id, 'boom', failedClaim.token!);
      const active = await manager.push('cancel-refusals', { data: {} });
      await manager.pullWithLock('cancel-refusals', 'refusal-worker');

      expect(await manager.cancel(active.id)).toBe(false);
      expect(await manager.cancel(failed.id)).toBe(false);
      expect(await manager.getJobState(active.id)).toBe('active');
      expect(await manager.getJobState(failed.id)).toBe('failed');
    } finally {
      await manager.shutdownPostgres();
    }
  });
});
