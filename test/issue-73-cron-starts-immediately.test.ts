/**
 * Issue #73 - Cron starts immediately on creation and after restart
 *
 * Bug 1: upsertJobScheduler fires the job immediately instead of waiting
 *         for the next scheduled time
 * Bug 2: After restart, if a job was running longer than the cron interval,
 *         the cron fires immediately instead of waiting for the next occurrence
 *
 * Root cause: CronScheduler.load() only recalculates nextRun to the future
 * when skipMissedOnRestart=true. With default (false), past nextRun values
 * cause immediate execution on tick().
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { CronScheduler } from '../src/infrastructure/scheduler/cronScheduler';
import type { CronJob } from '../src/domain/types/cron';
import type { JobInput } from '../src/domain/types/job';

/** Helper to access private tick() */
function tickScheduler(scheduler: CronScheduler): Promise<void> {
  return (scheduler as any).tick();
}

/** Create a minimal CronJob */
function makeCronJob(overrides: Partial<CronJob> & { name: string; queue: string }): CronJob {
  return {
    data: {},
    schedule: '* * * * *',
    repeatEvery: null,
    priority: 0,
    timezone: null,
    nextRun: Date.now() + 60000,
    executions: 0,
    maxLimit: null,
    uniqueKey: null,
    dedup: null,
    skipMissedOnRestart: true,
    skipIfNoWorker: false,
    ...overrides,
  } as CronJob;
}

describe('Issue #73: Cron starts immediately', () => {
  let scheduler: CronScheduler;
  let pushedJobs: Array<{ queue: string; input: JobInput }>;
  let persistedCrons: Array<{ name: string; executions: number; nextRun: number }>;

  beforeEach(() => {
    pushedJobs = [];
    persistedCrons = [];
    scheduler = new CronScheduler();
    scheduler.setPushCallback(async (queue: string, input: JobInput) => {
      pushedJobs.push({ queue, input });
    });
    scheduler.setPersistCallback((name: string, executions: number, nextRun: number) => {
      persistedCrons.push({ name, executions, nextRun });
    });
  });

  // -----------------------------------------------------------------
  // Bug 1: load() with past nextRun and skipMissedOnRestart=false
  //         should NOT fire immediately — but it does
  // -----------------------------------------------------------------
  test('load() with past nextRun should NOT fire immediately (fix #73)', async () => {
    const pastTime = Date.now() - 120_000; // 2 minutes ago

    scheduler.load([
      makeCronJob({
        name: 'every-minute',
        queue: 'tasks',
        schedule: '* * * * *',
        nextRun: pastTime,
        // skipMissedOnRestart defaults to true — missed crons are skipped
        executions: 5,
      }),
    ]);

    // With default skipMissedOnRestart=true, nextRun is recalculated to future
    await tickScheduler(scheduler);

    expect(pushedJobs.length).toBe(0);
  });

  // -----------------------------------------------------------------
  // Bug 2: load() with past nextRun when job ran longer than interval
  //         Simulates: cron every 1 min, job took 3 min, app restarted
  // -----------------------------------------------------------------
  test('load() after restart with long-running job should NOT fire immediately (fix #73)', async () => {
    const pastTime = Date.now() - 180_000; // 3 minutes ago

    scheduler.load([
      makeCronJob({
        name: 'slow-job-cron',
        queue: 'tasks',
        repeatEvery: 60_000, // every 60 seconds
        schedule: null,
        nextRun: pastTime, // was due 3 minutes ago while job was still running
        // skipMissedOnRestart defaults to true
        executions: 10,
      }),
    ]);

    // With default skipMissedOnRestart=true, nextRun is recalculated to future
    await tickScheduler(scheduler);

    expect(pushedJobs.length).toBe(0);
  });

  // -----------------------------------------------------------------
  // Verify: skipMissedOnRestart=true correctly prevents firing (existing behavior)
  // -----------------------------------------------------------------
  test('load() with skipMissedOnRestart=true correctly skips past nextRun', async () => {
    const pastTime = Date.now() - 120_000;

    scheduler.load([
      makeCronJob({
        name: 'skipped-cron',
        queue: 'tasks',
        schedule: '* * * * *',
        nextRun: pastTime,
        skipMissedOnRestart: true,
        executions: 5,
      }),
    ]);

    await tickScheduler(scheduler);

    // With skipMissedOnRestart=true, this should NOT fire
    expect(pushedJobs.length).toBe(0);
  });

  // -----------------------------------------------------------------
  // Bug 3: add() after load() should not cause immediate fire
  //         Simulates user calling upsertJobScheduler on app startup
  // -----------------------------------------------------------------
  test('add() called after load() should not fire immediately when not requested', async () => {
    // Simulate: server loaded a cron from DB
    const pastTime = Date.now() - 120_000;
    scheduler.load([
      makeCronJob({
        name: 'user-cron',
        queue: 'tasks',
        schedule: '*/5 * * * *', // every 5 minutes
        nextRun: pastTime,
        skipMissedOnRestart: false,
        executions: 3,
      }),
    ]);

    // Simulate: user calls upsertJobScheduler which calls add() again
    const cron = scheduler.add({
      name: 'user-cron',
      queue: 'tasks',
      data: {},
      schedule: '*/5 * * * *',
    });

    // nextRun should be in the future, not now
    expect(cron.nextRun).toBeGreaterThan(Date.now());

    // tick() should NOT fire
    await tickScheduler(scheduler);
    expect(pushedJobs.length).toBe(0);
  });

  // -----------------------------------------------------------------
  // Verify: add() with immediately=true on first creation SHOULD fire
  // -----------------------------------------------------------------
  test('add() with immediately=true on first creation fires once', async () => {
    scheduler.add({
      name: 'immediate-cron',
      queue: 'tasks',
      data: {},
      schedule: '*/5 * * * *',
      immediately: true,
    });

    await tickScheduler(scheduler);

    expect(pushedJobs.length).toBe(1);
    expect(pushedJobs[0].queue).toBe('tasks');
  });

  // -----------------------------------------------------------------
  // Bug 4: load() should preserve executions count across restart
  // -----------------------------------------------------------------
  test('load() then add() (upsert) preserves executions count', async () => {
    scheduler.load([
      makeCronJob({
        name: 'counted-cron',
        queue: 'tasks',
        schedule: '* * * * *',
        nextRun: Date.now() + 60_000,
        executions: 42,
      }),
    ]);

    // upsert same cron
    const cron = scheduler.add({
      name: 'counted-cron',
      queue: 'tasks',
      data: {},
      schedule: '* * * * *',
    });

    expect(cron.executions).toBe(42);
  });
});
