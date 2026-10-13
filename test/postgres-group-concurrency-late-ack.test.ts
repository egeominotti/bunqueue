/**
 * PostgreSQL parity for the embedded group concurrency late-ACK phantom
 * (test/repro-group-concurrency-late-ack-phantom.test.ts).
 *
 * The embedded engine completed a job that was waiting in the queue after a retry and
 * released a group concurrency slot that job did not hold, so a group with concurrency 1
 * admitted a second active job. The PostgreSQL engine derives group capacity from the
 * leased `active` rows inside the claim transaction (claimSelection.ts), and a
 * completion applies only to an `active` row whose lease token matches
 * (completionOutcome.ts, batchCompletion.ts). A retry clears the lease (outcomes.ts), so
 * a late ACK of the earlier attempt is rejected and no slot can be released twice.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { PostgresQueueManager } from '../src/application/postgresQueueManager';
import type { JobId } from '../src/domain/types/job';
import { cleanupPostgresNamespace } from './support/postgres-event-race';

const postgresUrl = Bun.env.BUNQUEUE_TEST_POSTGRES_URL;
const namespaces: string[] = [];
// A stored group override applies only when the Worker supplies the matching group
// default (BullMQ Pro local-override contract), so every pull carries it.
const group = { concurrency: 1 };

function namespace(label: string): string {
  const value = `test-group-late-ack-${label}-${Date.now()}-${crypto.randomUUID()}`;
  namespaces.push(value);
  return value;
}

async function withManager(
  label: string,
  run: (m: PostgresQueueManager) => Promise<void>
): Promise<void> {
  const m = new PostgresQueueManager({
    postgres: { url: postgresUrl!, namespace: namespace(label), brokerId: 'a', pollIntervalMs: 25 },
  });
  try {
    await m.waitUntilReady();
    await run(m);
  } finally {
    await m.shutdownPostgres();
  }
}

async function cleanupGroupState(url: string, value: string): Promise<void> {
  const sql = new SQL(url, { max: 1 });
  try {
    await sql`DELETE FROM bunqueue_group_state WHERE namespace = ${value}`;
  } finally {
    await sql.close({ timeout: 5 });
  }
}

afterAll(async () => {
  if (!postgresUrl) return;
  for (const value of namespaces) {
    await cleanupPostgresNamespace(postgresUrl, value);
    await cleanupGroupState(postgresUrl, value);
  }
});

interface RetriedGroup {
  readonly lateId: JobId;
  readonly lateToken: string;
  readonly runningId: JobId;
  readonly runningToken: string;
}

/** A fails and waits out a 60 s backoff while B of the same group runs. */
async function retryFirstAndRunSecond(
  m: PostgresQueueManager,
  queue: string
): Promise<RetriedGroup> {
  await m.setGroupConcurrency(queue, 'g', 1);
  await m.push(queue, { data: { n: 1 }, groupId: 'g', maxAttempts: 5, backoff: 60_000 });
  await m.push(queue, { data: { n: 2 }, groupId: 'g' });

  const first = await m.pullWithLock(queue, 'first-worker', 0, undefined, undefined, group);
  expect(first.job).not.toBeNull();
  expect(first.token).not.toBeNull();
  expect(await m.fail(first.job!.id, 'transient', first.token!)).toBeUndefined();
  expect(await m.getJobState(first.job!.id)).toBe('delayed');

  const second = await m.pullWithLock(queue, 'second-worker', 0, undefined, undefined, group);
  expect(second.job).not.toBeNull();
  expect(second.token).not.toBeNull();
  expect(String(second.job!.id)).not.toBe(String(first.job!.id));
  expect(await m.getGroupActiveCount(queue, 'g')).toBe(1);
  return {
    lateId: first.job!.id,
    lateToken: first.token!,
    runningId: second.job!.id,
    runningToken: second.token!,
  };
}

/** The group stays at one active job: a third job is not claimed while B runs. */
async function expectLimitHeld(
  m: PostgresQueueManager,
  queue: string,
  retried: RetriedGroup
): Promise<void> {
  expect(await m.getJobState(retried.lateId)).toBe('delayed');
  expect(await m.getJobState(retried.runningId)).toBe('active');
  expect(await m.getGroupActiveCount(queue, 'g')).toBe(1);

  const third = await m.push(queue, { data: { n: 3 }, groupId: 'g' });
  expect(await m.pull(queue, 0, undefined, group)).toBeNull();
  expect(await m.getJobState(third.id)).toBe('waiting');
  expect(m.getQueueJobCounts(queue).active).toBe(1);
  expect(await m.getGroupActiveCount(queue, 'g')).toBe(1);

  // Control: completing B frees the only slot, so the third job is admitted.
  expect(await m.ack(retried.runningId, 'done', retried.runningToken)).toBeUndefined();
  const next = await m.pull(queue, 0, undefined, group);
  expect(next).not.toBeNull();
  expect(String(next!.id)).toBe(String(third.id));
  expect(await m.getGroupActiveCount(queue, 'g')).toBe(1);
  expect(m.getQueueJobCounts(queue).active).toBe(1);
}

describe('PostgreSQL group concurrency survives a late ACK of a retried job', () => {
  test.skipIf(!postgresUrl)(
    'ACK rejects the retried attempt and the group admits no third job',
    () =>
      withManager('ack', async (m) => {
        const queue = 'group-late-ack';
        const retried = await retryFirstAndRunSecond(m, queue);

        // The retry released A's lease, so the manager no longer holds a token for it.
        await expect(m.ack(retried.lateId, 'late')).rejects.toThrow(
          `Lock token required for job ${String(retried.lateId)}`
        );
        // The first attempt's worker reports success with its original token.
        await expect(m.ack(retried.lateId, 'late', retried.lateToken)).rejects.toThrow(
          `Invalid or expired lock token for job ${String(retried.lateId)}`
        );

        await expectLimitHeld(m, queue, retried);
      }),
    30_000
  );

  test.skipIf(!postgresUrl)(
    'ackBatch rejects the retried attempt and the group admits no third job',
    () =>
      withManager('ack-batch', async (m) => {
        const queue = 'group-late-ack-batch';
        const retried = await retryFirstAndRunSecond(m, queue);

        await expect(m.ackBatch([retried.lateId], [retried.lateToken])).rejects.toThrow(
          `Invalid or expired lock token for job ${String(retried.lateId)}`
        );
        // A batch carrying the stale ACK beside B's valid one commits nothing.
        await expect(
          m.ackBatch([retried.lateId, retried.runningId], [retried.lateToken, retried.runningToken])
        ).rejects.toThrow(`Invalid or expired lock token for job ${String(retried.lateId)}`);

        await expectLimitHeld(m, queue, retried);
      }),
    30_000
  );
});
