/**
 * Repro: the PostgreSQL manager's job setters skipped the base engine's validation.
 *
 * `QueueManager.changePriority`, `updateProgress`, `updateJobData` and `clearLogs`
 * apply `src/domain/job/mutations.ts` (`priorityChangeValue`, `normalizeProgress`,
 * `validateUpdatedJobData`, `keepLogsArgument`), but the PostgreSQL overrides and
 * `clearLogsDurable` never call the base methods, so a TCP command routed to a
 * PostgreSQL broker and every Cloud command stored a NaN priority or progress. Each
 * call must reject exactly what the base engine rejects, with its message (computed
 * here by running the same call on an in-memory QueueManager), and apply everything
 * else with the base engine's (2.9.10's) result.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { PostgresQueueManager } from '../src/application/postgresQueueManager';
import { MAX_JOB_DATA_CHARS } from '../src/domain/job/mutations';
import type { JobId, JobInput } from '../src/domain/types/job';
import { cleanupPostgresNamespace } from './support/postgres-event-race';

const postgresUrl = Bun.env.BUNQUEUE_TEST_POSTGRES_URL;
const namespace = `test-timers-setters-${Date.now()}-${crypto.randomUUID()}`;
const oversized = { blob: 'x'.repeat(MAX_JOB_DATA_CHARS) };
const circular: Record<string, unknown> = {};
circular.self = circular;

let postgres: PostgresQueueManager | null = null;
let base: QueueManager | null = null;

afterAll(async () => {
  base?.shutdown();
  await postgres?.shutdownPostgres();
  if (postgresUrl) await cleanupPostgresNamespace(postgresUrl, namespace);
});

async function engines(): Promise<{ postgres: PostgresQueueManager; base: QueueManager }> {
  postgres ??= new PostgresQueueManager({
    postgres: { url: postgresUrl!, namespace, brokerId: 'setter-validation' },
  });
  base ??= new QueueManager();
  await postgres.waitUntilReady();
  return { postgres, base };
}

/** The message a call rejects with, or `resolved` when it does not reject. */
async function rejection(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return 'resolved';
  } catch (error) {
    return (error as Error).message;
  }
}

/** Push the same job to both engines and return their IDs. */
async function pushBoth(queue: string, input: JobInput): Promise<[JobId, JobId]> {
  const current = await engines();
  const stored = await current.postgres.push(queue, input);
  const local = await current.base.push(queue, input);
  return [stored.id, local.id];
}

describe('PostgreSQL job setters validate like the base engine', () => {
  test.skipIf(!postgresUrl)(
    'changePriority rejects NaN and applies every finite priority, missing = 0',
    async () => {
      const current = await engines();
      const [id, localId] = await pushBoth('setter-priority', { data: {}, priority: 3 });
      for (const priority of [Number.NaN, 'high']) {
        const expected = await rejection(() =>
          current.base.changePriority(localId, priority as number)
        );
        expect(expected).not.toBe('resolved');
        expect(await rejection(() => current.postgres.changePriority(id, priority as number))).toBe(
          expected
        );
      }
      expect((await current.postgres.getJob(id))?.priority).toBe(3);
      // As on 2.9.10: a non-boolean lifo is made a boolean, a missing priority is 0.
      expect(await current.postgres.changePriority(id, 4, 1 as unknown as boolean)).toBe(true);
      expect((await current.postgres.getJob(id))?.lifo).toBe(true);
      expect(await current.postgres.changePriority(id, undefined as unknown as number, false)).toBe(
        true
      );
      const reset = await current.postgres.getJob(id);
      expect({ priority: reset?.priority, lifo: reset?.lifo }).toEqual({
        priority: 0,
        lifo: false,
      });
      // As on 2.9.10: a fraction, BullMQ's 2,097,152 and a value beyond the INTEGER column
      // (the column is clamped; the payload keeps the exact priority).
      for (const priority of [1.5, 2_097_152, 5e9]) {
        expect(await current.base.changePriority(localId, priority)).toBe(true);
        expect(await current.postgres.changePriority(id, priority)).toBe(true);
        expect((await current.postgres.getJob(id))?.priority).toBe(priority);
      }
    }
  );

  test.skipIf(!postgresUrl)('a grouped job accepts every finite priority too', async () => {
    const current = await engines();
    const input = { data: {}, groupId: 'tenant-a', priority: 2 };
    const [id, localId] = await pushBoth('setter-group', input);
    const expected = await rejection(() => current.base.changePriority(localId, Number.NaN));
    expect(expected).toBe('priority must be a finite number');
    expect(await rejection(() => current.postgres.changePriority(id, Number.NaN))).toBe(expected);
    for (const priority of [-1, 2.5, 7]) {
      expect(await current.postgres.changePriority(id, priority)).toBe(true);
      expect((await current.postgres.getJob(id))?.priority).toBe(priority);
    }
  });

  test.skipIf(!postgresUrl)('a missing job is validated first, as in the base engine', async () => {
    const current = await engines();
    const missing = 'setter-missing' as JobId;
    const expected = await rejection(() => current.base.changePriority(missing, Number.NaN));
    expect(await rejection(() => current.postgres.changePriority(missing, Number.NaN))).toBe(
      expected
    );
    expect(await current.postgres.changePriority(missing, 5)).toBe(false);
  });

  test.skipIf(!postgresUrl)('updateProgress stores what the base engine stores', async () => {
    const current = await engines();
    await current.postgres.push('setter-progress', { data: {} });
    const claimed = await current.postgres.pullWithLock('setter-progress', 'w', 0);
    const id = claimed.job!.id;
    for (const [progress, stored] of [
      [Number.NaN, 0],
      ['50', 50],
      [true, 1],
    ] as Array<[unknown, number]>) {
      expect(await current.postgres.updateProgress(id, progress as number)).toBe(true);
      expect((await current.postgres.getJob(id))?.progress).toBe(stored);
    }
  });

  test.skipIf(!postgresUrl)(
    'updateJobData rejects an unserializable payload and accepts any size',
    async () => {
      const current = await engines();
      const [id, localId] = await pushBoth('setter-data', { data: { kept: true } });
      for (const data of [circular, { big: 1n }]) {
        const expected = await rejection(() => current.base.updateJobData(localId, data));
        expect(expected).not.toBe('resolved');
        expect(await rejection(() => current.postgres.updateJobData(id, data))).toBe(expected);
      }
      expect((await current.postgres.getJob(id))?.data).toEqual({ kept: true });
      expect(await current.postgres.updateJobData(id, oversized)).toBe(true);
    }
  );

  test.skipIf(!postgresUrl)(
    'clearLogsDurable rejects NaN and applies every number as 2.9.10 did',
    async () => {
      const current = await engines();
      const [id, localId] = await pushBoth('setter-logs', { data: {} });
      for (const message of ['first', 'second', 'third']) {
        await current.postgres.addLogDurable(id, message);
      }
      const expected = await rejection(async () => current.base.clearLogs(localId, Number.NaN));
      expect(expected).toBe('keepLogs must be a number');
      expect(await rejection(() => current.postgres.clearLogsDurable(id, Number.NaN))).toBe(
        expected
      );
      await current.postgres.clearLogsDurable(id, 1_000_001);
      expect(await current.postgres.getLogsDurable(id)).toHaveLength(3);
      await current.postgres.clearLogsDurable(id, 2.5);
      expect(await current.postgres.getLogsDurable(id)).toHaveLength(2);
      await current.postgres.clearLogsDurable(id, -1);
      expect(await current.postgres.getLogsDurable(id)).toHaveLength(0);
    }
  );
});
