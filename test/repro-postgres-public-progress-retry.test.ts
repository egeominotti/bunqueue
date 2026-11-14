import { expect, test } from 'bun:test';
import { SQL } from 'bun';
import type { Job } from '../src/client';
import {
  PostgresPublicApiHarness,
  waitFor,
  POSTGRES_PUBLIC_API_TEARDOWN_TIMEOUT_MS,
} from './support/postgres-public-api-harness';
import { expectedPostgresVersionPrefix } from './support/postgres-version';
import { PublicDeliveryTrace } from './support/postgres-public-delivery-trace';

const url = Bun.env.BUNQUEUE_TEST_POSTGRES_URL;

async function bounded<T>(work: Promise<T>, description: string, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out ${description}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test.skipIf(!url)(
  'a rolled-back Progress request retries with a new fenced delivery and one durable completion',
  async () => {
    const harness = await PostgresPublicApiHarness.start(url!, expectedPostgresVersionPrefix);
    const sql = new SQL(url!, { max: 2, connectionTimeout: 5 });
    const blocker = new SQL(url!, { max: 1, connectionTimeout: 5 });
    const first = Promise.withResolvers<Job<{ value: number }>>();
    const second = Promise.withResolvers<Job<{ value: number }>>();
    const issueProgress = Promise.withResolvers<void>();
    const rejected = Promise.withResolvers<unknown>();
    const releaseFailure = Promise.withResolvers<void>();
    const releaseSuccess = Promise.withResolvers<void>();
    const locked = Promise.withResolvers<number>();
    const unlock = Promise.withResolvers<void>();
    const deliveries: { id: string; token?: string; attempts: number }[] = [];
    const failures: { id?: string; token?: string; error: string }[] = [];
    const trace = new PublicDeliveryTrace();
    let lock: Promise<unknown> | undefined;
    let primaryError: unknown;
    try {
      const name = harness.unique('progress-lock-retry');
      const queue = harness.queue<{ value: number }>(name, 0);
      const observer = harness.queue<{ value: number }>(name, 3);
      const worker = harness.worker<{ value: number }, number>(
        name,
        1,
        async (job) => {
          const invocation = trace.start(job);
          deliveries.push({ id: job.id, token: job.token, attempts: job.attemptsMade });
          try {
            if (deliveries.length === 1) {
              first.resolve(job);
              await issueProgress.promise;
              try {
                await job.updateProgress({ phase: 'running' });
              } catch (error) {
                rejected.resolve(error);
                await releaseFailure.promise;
                throw error;
              }
              throw new Error('Progress unexpectedly escaped the owned SQL row lock');
            }
            second.resolve(job);
            await releaseSuccess.promise;
            await job.updateProgress({ phase: 'running' });
            invocation.stage = 'log';
            await job.log(`processed-${job.data.value}`);
            return trace.returned(invocation, job.data.value * 2);
          } catch (error) {
            trace.threw(invocation, error);
            throw error;
          }
        },
        { concurrency: 1 }
      );
      worker.on('failed', (job, error) => {
        trace.failed(job, error);
        failures.push({ id: job?.id, token: job?.token, error: String(error) });
      });
      worker.on('error', (error) => trace.unexpected('error', error));
      worker.on('stalled', (id) => trace.unexpected('stalled', id));
      await worker.waitUntilReady();
      const job = await queue.add('double', { value: 7 }, { durable: true });
      await waitFor('first processor entry', () => deliveries.length === 1);
      const initial = await first.promise;
      lock = blocker.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = '5s'`;
        await tx`SELECT id FROM bunqueue_jobs WHERE namespace = ${harness.namespace}
          AND id = ${job.id} FOR UPDATE`;
        const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        locked.resolve(row.pid);
        await unlock.promise;
      });
      // Observe rejection immediately, including failures before the lock-ready barrier.
      void lock.catch(() => {});
      let blockerPid: number | undefined;
      void locked.promise.then((pid) => {
        blockerPid = pid;
      });
      await waitFor('owned row lock', () => blockerPid !== undefined);
      issueProgress.resolve();
      await waitFor('Progress blocked by the owned transaction', async () => {
        const [row] = await sql<{ waiting: boolean }[]>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE ${blockerPid!} = ANY(pg_blocking_pids(pid))
        ) AS waiting`;
        return row.waiting;
      });
      let progressError: unknown;
      void rejected.promise.then((error) => {
        progressError = error;
      });
      await waitFor('Progress lock-timeout response', () => progressError !== undefined, 10_000);
      expect(String(progressError)).toContain('Internal server error');
      const [before] = await sql<{ attempts: number; lease_token: string }[]>`
        SELECT attempts, lease_token FROM bunqueue_jobs
        WHERE namespace = ${harness.namespace} AND id = ${job.id}`;
      expect(before.attempts).toBe(0);
      expect(before.lease_token).toBe(initial.token!);
      unlock.resolve();
      await lock;
      releaseFailure.resolve();
      await waitFor('retry processor entry', () => deliveries.length === 2);
      const retry = await second.promise;
      expect(failures).toEqual([
        { id: job.id, token: initial.token, error: String(progressError) },
      ]);
      expect(initial.token).toBeTruthy();
      expect(retry.token).toBeTruthy();
      expect(retry.token).not.toBe(initial.token);
      expect(deliveries.map(({ attempts }) => attempts)).toEqual([0, 1]);
      const [active] = await sql<{ attempts: number; lease_token: string }[]>`
        SELECT attempts, lease_token FROM bunqueue_jobs
        WHERE namespace = ${harness.namespace} AND id = ${job.id}`;
      expect(active).toEqual({ attempts: 1, lease_token: retry.token! });
      releaseSuccess.resolve();
      await waitFor(
        'one completed retry',
        async () => (await observer.getJobCountsAsync()).completed === 1
      );
      expect(await observer.getJobCountsAsync()).toMatchObject({
        waiting: 0,
        active: 0,
        completed: 1,
        failed: 0,
        delayed: 0,
        prioritized: 0,
        paused: 0,
        'waiting-children': 0,
      });
      expect(await observer.getJobState(job.id)).toBe('completed');
      const [events] = await sql<{ failed: string; completed: string }[]>`
        SELECT count(*) FILTER (WHERE event_type = 'failed')::text AS failed,
          count(*) FILTER (WHERE event_type = 'completed')::text AS completed
        FROM bunqueue_events WHERE namespace = ${harness.namespace} AND job_id = ${job.id}`;
      expect(events).toEqual({ failed: '1', completed: '1' });
      const retained = await observer.getJob(job.id);
      expect(retained?.returnvalue).toBe(14);
      expect(retained?.attemptsMade).toBe(1);
      expect(await observer.getJobLogs(job.id)).toMatchObject({
        count: 1,
        logs: ['[info] processed-7'],
      });
      await trace.assert(url!, harness.namespace, name, new Map([[job.id, 14]]));
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      issueProgress.resolve();
      unlock.resolve();
      releaseFailure.resolve();
      releaseSuccess.resolve();
      const lockCleanup = await Promise.allSettled([
        bounded(Promise.resolve(lock), 'releasing owned row lock', 10_000),
      ]);
      const resources = await Promise.allSettled([
        bounded(
          harness.close(),
          'closing public API fixture',
          POSTGRES_PUBLIC_API_TEARDOWN_TIMEOUT_MS
        ),
        sql.close({ timeout: 5 }),
        blocker.close({ timeout: 5 }),
      ]);
      const errors = [...lockCleanup, ...resources].flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (errors.length)
        throw new AggregateError(
          primaryError ? [primaryError, ...errors] : errors,
          'Progress retry cleanup failed'
        );
    }
  },
  POSTGRES_PUBLIC_API_TEARDOWN_TIMEOUT_MS + 30_000
);
