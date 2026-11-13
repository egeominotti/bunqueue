/**
 * Repro (2.9.10 compatibility, PostgreSQL engine): a past run time.
 *
 * The SQLite engines' cases live in `test/repro-compat-job-past-run-time.test.ts`;
 * this case needs PostgreSQL, so it lives in a `repro-postgres-*` file that
 * `bun run test:postgres` selects. On 2.9.10 the PostgreSQL engine stored
 * `runAt = now + delay` for a negative job `delay` (the job ran ahead of earlier
 * ready jobs) and clamped a negative ChangeDelay to now (`now + Math.max(0, delay)`);
 * the engines differed, and both behaviours must be kept.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { PostgresQueueManager } from '../src/application/postgresQueueManager';
import { cleanupPostgresNamespace } from './support/postgres-event-race';

const PAST = -5_000;
const postgresUrl = Bun.env.BUNQUEUE_TEST_POSTGRES_URL;
const namespace = `test-compat-past-run-${Date.now()}-${crypto.randomUUID()}`;

let postgres: PostgresQueueManager | null = null;

afterAll(async () => {
  await postgres?.shutdownPostgres();
  if (postgresUrl) await cleanupPostgresNamespace(postgresUrl, namespace);
});

describe('PostgreSQL keeps its own 2.9.10 results', () => {
  test.skipIf(!postgresUrl)(
    'push keeps a past run time; changeDelay clamps a negative delay to now',
    async () => {
      postgres = new PostgresQueueManager({
        postgres: { url: postgresUrl!, namespace, brokerId: 'compat-past' },
      });
      await postgres.waitUntilReady();
      await postgres.push('pg-past', { name: 'first', data: {} });
      const late = await postgres.push('pg-past', { name: 'late', data: {}, delay: PAST });
      expect(late.runAt).toBe(late.createdAt + PAST);
      const moved = await postgres.push('pg-past', { name: 'moved', data: {}, delay: 60_000 });
      const before = Date.now();
      // 2.9.10's PostgreSQL engine applied `now + Math.max(0, delay)`; the engines differed.
      expect(await postgres.changeDelay(moved.id, PAST * 2)).toBe(true);
      expect(await postgres.getJobState(moved.id)).toBe('waiting');
      expect((await postgres.getJob(moved.id))!.runAt).toBeGreaterThanOrEqual(before - 1_000);
      const order: string[] = [];
      for (let index = 0; index < 3; index++) {
        order.push((await postgres.pull('pg-past', 0))?.name ?? '-');
      }
      expect(order).toEqual(['late', 'first', 'moved']);
    }
  );
});
