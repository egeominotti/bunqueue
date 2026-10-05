/**
 * Repro: the PostgreSQL manager skipped the base QueueManager's argument validation.
 *
 * Its `pull`, `pullWithLock`, `pullBatch`, `pullBatchWithLock`, `extendLock`,
 * `renewJobLock`, `changeDelay` and `moveToDelayed` overrides never call the base
 * methods, so a direct caller (the cloud PostgreSQL adapter, embedded use of the
 * manager) bypassed `pullTimeoutArgument`, `assertLockDuration` and `delayArgument`: a
 * NaN lock TTL or renewal silently became the configured lease, and a NaN delay reached
 * SQL. TCP was covered by its handlers. Each call must now reject what the base engine
 * rejects, with its message, and change nothing; every finite value keeps the base
 * engine's (2.9.10's) result: a lease of 0 is granted, a NaN wait means no wait.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { PostgresQueueManager } from '../src/application/postgresQueueManager';
import { cleanupPostgresNamespace } from './support/postgres-event-race';

const postgresUrl = Bun.env.BUNQUEUE_TEST_POSTGRES_URL;
const namespace = `test-timers-direct-validation-${Date.now()}-${crypto.randomUUID()}`;
let manager: PostgresQueueManager | null = null;

afterAll(async () => {
  await manager?.shutdownPostgres();
  if (postgresUrl) await cleanupPostgresNamespace(postgresUrl, namespace);
});

async function open(): Promise<PostgresQueueManager> {
  manager ??= new PostgresQueueManager({
    postgres: { url: postgresUrl!, namespace, brokerId: 'direct-validation' },
  });
  await manager.waitUntilReady();
  return manager;
}

describe('PostgreSQL manager arguments are validated like the base engine', () => {
  test.skipIf(!postgresUrl)('a NaN or infinite lock TTL is rejected before any claim', async () => {
    const current = await open();
    const pushed = await current.push('direct-ttl', { data: {} });
    for (const lockTtl of [Number.NaN, Infinity]) {
      await expect(current.pullWithLock('direct-ttl', 'worker', 0, lockTtl)).rejects.toThrow(
        /^lockTtl must be/
      );
      await expect(
        current.pullBatchWithLock('direct-ttl', 1, 'worker', 0, lockTtl)
      ).rejects.toThrow(/^lockTtl must be/);
    }
    expect(await current.getJobState(pushed.id)).toBe('waiting');
    const { job } = await current.pullWithLock('direct-ttl', 'worker', 0, 0);
    expect(String(job?.id)).toBe(String(pushed.id));
  });

  test.skipIf(!postgresUrl)('a NaN or negative pull timeout means no wait', async () => {
    const current = await open();
    expect(await current.pull('direct-timeout', Number.NaN)).toBeNull();
    expect(await current.pullBatch('direct-timeout', 1, -1)).toEqual([]);
    const pushed = await current.push('direct-timeout', { data: {} });
    expect(String((await current.pull('direct-timeout', 120_000))?.id)).toBe(String(pushed.id));
  });

  test.skipIf(!postgresUrl)(
    'a NaN or infinite renewal duration is rejected and renews nothing',
    async () => {
      const current = await open();
      await current.push('direct-renew', { data: {} });
      const { job, token } = await current.pullWithLock('direct-renew', 'worker', 0, 60_000);
      expect(job).not.toBeNull();
      const before = current.getLockInfo(job!.id);

      for (const duration of [Number.NaN, Infinity]) {
        await expect(current.extendLock(job!.id, token, duration)).rejects.toThrow(
          /^duration must be/
        );
        expect(() => current.renewJobLock(job!.id, token!, duration)).toThrow(/^duration must be/);
      }
      await current.flushPostgresWrites();
      expect(current.getLockInfo(job!.id)?.renewalCount).toBe(before?.renewalCount);
    }
  );

  test.skipIf(!postgresUrl)('a NaN delay is rejected, while 0 still means now', async () => {
    const current = await open();
    await current.push('direct-delay', { data: {} });
    const { job, token } = await current.pullWithLock('direct-delay', 'worker', 0, 60_000);
    expect(job).not.toBeNull();

    await expect(current.changeDelay(job!.id, Number.NaN, token!)).rejects.toThrow(
      /^delay must be/
    );
    await expect(current.moveToDelayed(job!.id, Number.NaN, token!)).rejects.toThrow(
      /^delay must be/
    );
    expect(await current.getJobState(job!.id)).toBe('active');

    expect(await current.changeDelay(job!.id, 0, token!)).toBe(true);
    expect(['waiting', 'prioritized']).toContain(await current.getJobState(job!.id));
  });
});
