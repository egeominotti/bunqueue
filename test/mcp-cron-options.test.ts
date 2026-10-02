/**
 * bunqueue_add_cron options (time zone, job name and options, run limit, immediate run,
 * overlap, no-worker and deduplication policies) reach the scheduler and change what it
 * produces, and add/list/get report the same fields. Every case runs against both
 * backends with identical expectations.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { QueueManager } from '../src/application/queueManager';
import { getSharedManager } from '../src/client/manager';
import { jobId as toJobId } from '../src/domain/types/job';
import { startMcp, type McpMode } from './mcp-harness';

type Mcp = Awaited<ReturnType<typeof startMcp>>;
type Cron = {
  name: string;
  nextRun: string | null;
  executions: number;
  jobName: string;
  priority: number;
  timezone: string | null;
  maxLimit: number | null;
};
type ListedJob = { id: string; name: string; priority: number; maxAttempts: number; data: unknown };

const MODES: McpMode[] = ['embedded', 'tcp'];
const DAY_MS = 24 * 60 * 60 * 1000;
/** A schedule that fires on creation and then every 100 ms. */
const FAST = { repeatEvery: 100, immediately: true };
const open: Mcp[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});
async function mcp(mode: McpMode) {
  const m = await startMcp({ mode });
  open.push(m);
  return m;
}

const engine = (m: Mcp): QueueManager => m.broker ?? getSharedManager();

function tryAdd(m: Mcp, args: Record<string, unknown>) {
  return m.call('bunqueue_add_cron', { name: 'c', queue: 'q', data: {}, ...args });
}

async function addCron(m: Mcp, args: Record<string, unknown>): Promise<Cron> {
  const result = await tryAdd(m, args);
  expect(result.isError).toBe(false);
  const { success, ...cron } = result.json;
  expect(success).toBe(true);
  return cron as unknown as Cron;
}

async function getCron(m: Mcp, name: string) {
  return m.call('bunqueue_get_cron', { name });
}

async function listed(m: Mcp, name: string): Promise<Cron | undefined> {
  const crons = (await m.call('bunqueue_list_crons')).json.crons as Cron[];
  return crons.find((cron) => cron.name === name);
}

async function jobsOf(m: Mcp, queue: string): Promise<ListedJob[]> {
  return (await m.call('bunqueue_get_jobs', { queue, end: 100 })).json.jobs as ListedJob[];
}

/** Polls `read` until `done` holds or 5 s pass; returns the last value. */
async function until<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await Bun.sleep(20);
  }
}

/** The queue's jobs once at least `n` exist (or after the deadline). */
const waitJobs = (m: Mcp, queue: string, n: number) =>
  until(
    () => jobsOf(m, queue),
    (jobs) => jobs.length >= n
  );

/** Hour and minute of `iso` on the wall clock of `timeZone`, as "HH:MM". */
function wallClock(iso: string, timeZone: string): string {
  const format = { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const;
  return new Intl.DateTimeFormat('en-GB', format).format(new Date(iso));
}

for (const mode of MODES) {
  describe(`[${mode}] bunqueue_add_cron time zone`, () => {
    test('the next run is computed in the given zone and round-trips', async () => {
      const m = await mcp(mode);
      const tokyo = await addCron(m, {
        name: 'tokyo',
        schedule: '0 9 * * *',
        timezone: 'Asia/Tokyo',
      });
      expect(tokyo.timezone).toBe('Asia/Tokyo');
      // Tokyo is UTC+9 all year: 09:00 there is 00:00 UTC.
      const next = new Date(tokyo.nextRun ?? '');
      expect([next.getUTCHours(), next.getUTCMinutes()]).toEqual([0, 0]);
      expect(next.getTime() - Date.now()).toBeGreaterThan(0);
      expect(next.getTime() - Date.now()).toBeLessThanOrEqual(DAY_MS);
      expect(await listed(m, 'tokyo')).toEqual(tokyo);
      expect((await getCron(m, 'tokyo')).json).toEqual(tokyo);

      const tz = 'America/New_York';
      const ny = await addCron(m, { name: 'ny', schedule: '30 9 * * *', timezone: tz });
      expect(wallClock(ny.nextRun ?? '', tz)).toBe('09:30');

      const utc = await addCron(m, { name: 'utc', schedule: '0 9 * * *' });
      expect(utc.timezone).toBeNull();
      expect(new Date(utc.nextRun ?? '').getUTCHours()).toBe(9);
    });

    test('an unknown zone, or a zone without a cron pattern, is an error', async () => {
      const m = await mcp(mode);
      const unknown = await tryAdd(m, {
        name: 'mars',
        schedule: '0 9 * * *',
        timezone: 'Mars/Olympus',
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.text).toContain('Unknown time zone');
      expect((await getCron(m, 'mars')).isError).toBe(true);
      for (const timezone of ['', '+02:00']) {
        expect((await tryAdd(m, { schedule: '0 9 * * *', timezone })).isError).toBe(true);
      }

      const interval = await tryAdd(m, {
        name: 'iv',
        repeatEvery: 60_000,
        timezone: 'Europe/Rome',
      });
      expect(interval.isError).toBe(true);
      expect(interval.text).toContain('timezone applies only to a cron pattern');
      expect(await listed(m, 'iv')).toBeUndefined();
    });
  });

  describe(`[${mode}] bunqueue_add_cron produced jobs`, () => {
    test('job name, priority and job options are applied to every produced job', async () => {
      const m = await mcp(mode);
      const cron = await addCron(m, {
        name: 'report',
        queue: 'opts',
        data: { kind: 'daily' },
        repeatEvery: DAY_MS,
        immediately: true,
        jobName: 'build-report',
        priority: 7,
        attempts: 5,
        backoff: 250,
        timeout: 5000,
        removeOnComplete: true,
      });
      expect(cron).toMatchObject({ jobName: 'build-report', priority: 7, maxLimit: null });
      expect(await listed(m, 'report')).toMatchObject({ jobName: 'build-report', priority: 7 });

      const [job] = await waitJobs(m, 'opts', 1);
      expect(job).toMatchObject({ name: 'build-report', priority: 7, maxAttempts: 5 });
      expect(job.data).toEqual({ kind: 'daily' });
      const stored = await engine(m).getJob(toJobId(job.id));
      expect(stored).toMatchObject({ backoff: 250, timeout: 5000, removeOnComplete: true });
    });

    test('without jobName the produced jobs are named "default"', async () => {
      const m = await mcp(mode);
      const data = { name: 'not-the-job-name' };
      const cron = await addCron(m, {
        queue: 'unnamed',
        data,
        repeatEvery: DAY_MS,
        immediately: true,
      });
      expect(cron.jobName).toBe('default');
      const [job] = await waitJobs(m, 'unnamed', 1);
      expect(job.name).toBe('default');
      expect(job.data).toEqual(data);
    });

    test('maxLimit stops the schedule after N runs', async () => {
      const m = await mcp(mode);
      const args = { name: 'three', queue: 'limited', maxLimit: 3, preventOverlap: false };
      expect((await addCron(m, { ...FAST, ...args })).maxLimit).toBe(3);
      expect(await waitJobs(m, 'limited', 3)).toHaveLength(3);
      // The exhausted schedule is dropped at its next due time and never fires again.
      const gone = await until(
        async () => (await getCron(m, 'three')).isError,
        (missing) => missing
      );
      expect(gone).toBe(true);
      await Bun.sleep(400);
      expect(await jobsOf(m, 'limited')).toHaveLength(3);
    });

    test('preventOverlap (default) keeps one pending job while runs keep counting', async () => {
      const m = await mcp(mode);
      await addCron(m, { ...FAST, name: 'single', queue: 'overlap' });
      const cron = await until(
        async () => (await getCron(m, 'single')).json as Cron,
        (c) => c.executions >= 3
      );
      expect(cron.executions).toBeGreaterThanOrEqual(3);
      expect(await jobsOf(m, 'overlap')).toHaveLength(1);
    });

    test('a shared deduplication key keeps one pending job across schedules', async () => {
      const m = await mcp(mode);
      const deduplication = { id: 'one-report' };
      await addCron(m, { ...FAST, name: 'first', queue: 'dedup', deduplication });
      await addCron(m, { ...FAST, name: 'second', queue: 'dedup', deduplication });
      await until(
        async () => (await listed(m, 'second'))?.executions ?? 0,
        (runs) => runs >= 2
      );
      expect(await jobsOf(m, 'dedup')).toHaveLength(1);
    });

    test('skipIfNoWorker skips runs until a worker is registered', async () => {
      const m = await mcp(mode);
      await addCron(m, { ...FAST, name: 'needs-worker', queue: 'workers', skipIfNoWorker: true });
      await Bun.sleep(350);
      expect(await jobsOf(m, 'workers')).toHaveLength(0);
      expect((await listed(m, 'needs-worker'))?.executions).toBe(0);

      await m.call('bunqueue_register_worker', { name: 'w', queues: ['workers'] });
      expect(await waitJobs(m, 'workers', 1)).toHaveLength(1);
    });

    test('every option reaches the scheduler unchanged', async () => {
      const m = await mcp(mode);
      const options = {
        jobName: 'sync',
        priority: -3,
        timezone: 'Europe/Rome',
        maxLimit: 10,
        skipIfNoWorker: true,
        preventOverlap: false,
        skipMissedOnRestart: false,
      };
      const jobOptions = {
        backoff: { type: 'fixed', delay: 1000 },
        timeout: 30_000,
        delay: 500,
        stallTimeout: 20_000,
        removeOnComplete: false,
        removeOnFail: true,
      };
      await addCron(m, {
        ...options,
        ...jobOptions,
        name: 'full',
        schedule: '*/5 * * * *',
        deduplication: { id: 'sync-key', ttl: 60_000, replace: true },
        attempts: 2,
      });
      expect(engine(m).getCron('full')).toMatchObject({
        ...options,
        uniqueKey: 'sync-key',
        dedup: { ttl: 60_000, replace: true },
        jobOptions: { ...jobOptions, maxAttempts: 2 },
      });
      const { jobName, priority, timezone, maxLimit } = options;
      expect(await listed(m, 'full')).toMatchObject({ jobName, priority, timezone, maxLimit });
    });

    test('invalid option values are rejected', async () => {
      const m = await mcp(mode);
      for (const args of [
        { maxLimit: 0 },
        { maxLimit: 1.5 },
        { jobName: '' },
        { attempts: 0 },
        { priority: 1.5 },
        { repeatEvery: 0 },
      ]) {
        expect((await tryAdd(m, { name: 'rejected', repeatEvery: 60_000, ...args })).isError).toBe(
          true
        );
      }
      expect(await listed(m, 'rejected')).toBeUndefined();
    });
  });
}
