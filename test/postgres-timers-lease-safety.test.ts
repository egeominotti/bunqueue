/**
 * Repro: PostgreSQL lease deadlines derived from unchecked durations.
 *
 * `lease_until` is a BIGINT bound through a BIGINT array (fractions, NaN and
 * infinities are rejected) and decoded with `numeric()` (anything beyond
 * Number.MAX_SAFE_INTEGER is rejected). A fractional or NaN timeout/stallTimeout left
 * in a stored payload therefore failed every claim of the queue head, a huge lock TTL
 * wrote a row no broker could read back, and a timeout of 0 (no timeout in the core
 * engine) produced a 1 ms lease that recovery then reported as a timeout.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createJob, jobId, type JobInput } from '../src/domain/types/job';
import { PostgresQueueStore } from '../src/infrastructure/persistence/postgres';
import { recoverExpiredPostgresLeases } from '../src/infrastructure/persistence/postgres/recovery';
import { cleanupPostgresNamespace } from './support/postgres-event-race';

const postgresUrl = Bun.env.BUNQUEUE_TEST_POSTGRES_URL;
/** The latest instant a JavaScript Date represents: a lease that never expires. */
const NEVER_EXPIRES_MS = 8_640_000_000_000_000;
const namespaces: string[] = [];
const stores: PostgresQueueStore[] = [];

async function openStore(label: string, leaseDurationMs?: number): Promise<PostgresQueueStore> {
  const namespace = `test-timers-lease-${label}-${Date.now()}-${crypto.randomUUID()}`;
  namespaces.push(namespace);
  const store = new PostgresQueueStore({
    url: postgresUrl!,
    namespace,
    brokerId: label,
    ...(leaseDurationMs !== undefined && { leaseDurationMs }),
  });
  stores.push(store);
  await store.initialize();
  return store;
}

async function insert(store: PostgresQueueStore, queue: string, id: string, input = {}) {
  await store.insert(createJob(jobId(id), queue, { data: {}, ...input } as JobInput));
}

function leaseMs(claim: { leaseUntil: number; job: { startedAt: number | null } }): number {
  return claim.leaseUntil - claim.job.startedAt!;
}

afterAll(async () => {
  await Promise.allSettled(stores.map((store) => store.close()));
  if (!postgresUrl) return;
  for (const namespace of namespaces) await cleanupPostgresNamespace(postgresUrl, namespace);
});

describe('PostgreSQL lease deadlines for any duration', () => {
  test.skipIf(!postgresUrl)(
    'a stored fractional or NaN timeout never blocks the queue head',
    async () => {
      const store = await openStore('poison');
      const cases = [
        { input: { stallTimeout: Number.NaN }, lease: 30_000 },
        { input: { stallTimeout: 1500.5 }, lease: 1501 },
        { input: { timeout: 1500.5 }, lease: 1501 },
      ];
      for (const [index, { input, lease }] of cases.entries()) {
        const queue = `poison-${index}`;
        await insert(store, queue, `${queue}-head`, input);
        await insert(store, queue, `${queue}-next`);

        const claims = await store.claim(queue, 2, 'worker', 30_000);

        expect(claims.map((claim) => String(claim.job.id))).toEqual([
          `${queue}-head`,
          `${queue}-next`,
        ]);
        expect(leaseMs(claims[0])).toBe(lease);
        expect(leaseMs(claims[1])).toBe(30_000);
      }
    }
  );

  test.skipIf(!postgresUrl)(
    'a timeout of 0 means no timeout for claims, renewals and recovery',
    async () => {
      const store = await openStore('zero-timeout');
      await insert(store, 'zero', 'zero-timeout', { timeout: 0, maxAttempts: 3 });

      const [claim] = await store.claim('zero', 1, 'worker', 60_000);
      expect(leaseMs(claim)).toBe(60_000);
      const [renewed] = await store.renewMany([
        { id: claim.job.id, token: claim.token, durationMs: 120_000 },
      ]);
      expect(renewed?.row.leaseUntil).toBeGreaterThanOrEqual(claim.leaseUntil + 60_000);

      await store.context.sql`
      UPDATE bunqueue_jobs SET lease_until = 0
      WHERE namespace = ${store.config.namespace} AND id = ${String(claim.job.id)}
    `;
      expect(await recoverExpiredPostgresLeases(store.context)).toBe(1);
      const recovered = await store.getJob(claim.job.id);
      expect(recovered?.job.stallCount).toBe(1);
      expect(recovered?.dlqRetryState?.attempts.map((attempt) => attempt.reason)).toEqual([
        'stalled',
      ]);
    }
  );

  test.skipIf(!postgresUrl)(
    'claims turn any lock TTL into a valid, readable deadline',
    async () => {
      const store = await openStore('claim-ttl', 45_000);
      const cases: Array<[number, (lease: number, leaseUntil: number) => void]> = [
        [30_000.5, (lease) => expect(lease).toBe(30_001)],
        [Number.NaN, (lease) => expect(lease).toBe(45_000)],
        [Number.POSITIVE_INFINITY, (_lease, until) => expect(until).toBe(NEVER_EXPIRES_MS)],
        [Number.MAX_SAFE_INTEGER, (_lease, until) => expect(until).toBe(NEVER_EXPIRES_MS)],
        [0, (lease) => expect(lease).toBe(1)],
      ];
      for (const [index, [ttl, check]] of cases.entries()) {
        const queue = `ttl-${index}`;
        await insert(store, queue, `${queue}-job`);

        const [claim] = await store.claim(queue, 1, 'worker', ttl);

        check(leaseMs(claim), claim.leaseUntil);
        const stored = await store.getJob(claim.job.id);
        expect(stored?.leaseUntil).toBe(claim.leaseUntil);
      }
    }
  );

  test.skipIf(!postgresUrl)(
    'renewals turn any duration into a valid, readable deadline',
    async () => {
      const store = await openStore('renew-ttl', 45_000);
      await insert(store, 'renew', 'renew-job');
      const [claim] = await store.claim('renew', 1, 'worker', 60_000);
      /** Renew, then return the granted lease bounds measured on the database clock. */
      const renew = async (durationMs: number) => {
        const before = await store.now();
        const [renewed] = await store.renewMany([
          { id: claim.job.id, token: claim.token, durationMs },
        ]);
        const after = await store.now();
        expect(renewed).toBeDefined();
        expect((await store.getJob(claim.job.id))?.leaseUntil).toBe(renewed.row.leaseUntil);
        return { min: renewed.row.leaseUntil - after, max: renewed.row.leaseUntil - before };
      };

      const fractional = await renew(10_000.5);
      expect(fractional.min).toBeLessThanOrEqual(10_001);
      expect(fractional.max).toBeGreaterThanOrEqual(10_001);
      const unspecified = await renew(Number.NaN);
      expect(unspecified.min).toBeLessThanOrEqual(45_000);
      expect(unspecified.max).toBeGreaterThanOrEqual(45_000);
      for (const durationMs of [Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
        const [renewed] = await store.renewMany([
          { id: claim.job.id, token: claim.token, durationMs },
        ]);
        expect(renewed?.row.leaseUntil).toBe(NEVER_EXPIRES_MS);
        expect((await store.getJob(claim.job.id))?.leaseUntil).toBe(NEVER_EXPIRES_MS);
      }
    }
  );

  // As on 2.9.10, only a claim is shortened to the stall timeout: a renewal grants the
  // requested lease (still never past the processing deadline), so a Worker whose
  // heartbeat interval exceeds the job's stallTimeout keeps its lease
  // (repro-compat-job-pg-lease.test.ts).
  test.skipIf(!postgresUrl)(
    'a claim is capped by the stall timeout, a renewal is not',
    async () => {
      const store = await openStore('renew-stall');
      const cases = [
        { input: { stallTimeout: 5_000 }, claimed: 5_000, lease: 60_000 },
        { input: { stallTimeout: Number.NaN }, claimed: 60_000, lease: 60_000 },
        { input: { stallTimeout: 5_000, timeout: 120_000 }, claimed: 5_000, lease: 60_000 },
      ];
      for (const [index, { input, claimed, lease }] of cases.entries()) {
        const queue = `renew-stall-${index}`;
        await insert(store, queue, `${queue}-job`, input);
        const [claim] = await store.claim(queue, 1, 'worker', 60_000);
        expect(leaseMs(claim)).toBe(claimed);

        const before = await store.now();
        const renewed = await store.renewMany([
          { id: claim.job.id, token: claim.token, durationMs: 60_000 },
        ]);
        const after = await store.now();

        expect(renewed).toHaveLength(1);
        expect(renewed[0].row.leaseUntil).toBeGreaterThanOrEqual(before + lease);
        expect(renewed[0].row.leaseUntil).toBeLessThanOrEqual(after + lease);
      }
    }
  );

  test.skipIf(!postgresUrl)('the longest configured lease writes a readable deadline', async () => {
    const store = await openStore('max-lease', Number.MAX_SAFE_INTEGER);
    await insert(store, 'max', 'max-lease-job');

    const [claim] = await store.claim('max', 1);

    expect(claim.leaseUntil).toBe(NEVER_EXPIRES_MS);
    expect((await store.getJob(claim.job.id))?.leaseUntil).toBe(NEVER_EXPIRES_MS);
  });
});
