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
  // Verify: skipMissedOnRestart=true correctly prevents firing (existing behavior).
  // The interval-based variant is in issue-61-cron-missed.test.ts.
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

  // load() then add() preserving the executions count: issue-65-skipMissedOnRestart.test.ts.
});
