/**
 * Test: Issue #61 comment - Cron jobs missed during downtime
 *
 * Reproduces the bug: when cron jobs with skipMissedOnRestart=true are loaded
 * with nextRun in the past, they should be skipped to the next future run.
 */
import { describe, it, expect } from 'bun:test';
import { CronScheduler } from '../src/infrastructure/scheduler/cronScheduler';
import type { CronJob } from '../src/domain/types/cron';

/** Access private tick() */
function tickScheduler(scheduler: CronScheduler): Promise<void> {
  return (scheduler as any).tick();
}

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
    skipMissedOnRestart: false,
    ...overrides,
  } as CronJob;
}

describe('Issue #61: cron missed jobs on restart', () => {
  // The schedule-based cases (skip and catch-up) are in issue-65-tcp-mode.test.ts.
  it('with skipMissedOnRestart=true on interval-based cron', async () => {
    const pushedJobs: Array<{ queue: string }> = [];
    const scheduler = new CronScheduler({ checkIntervalMs: 50 });

    scheduler.setPushCallback(async (queue) => {
      pushedJobs.push({ queue });
    });
    scheduler.setPersistCallback(() => {});

    scheduler.load([
      makeCronJob({
        name: 'missed-interval',
        queue: 'test-queue',
        schedule: null,
        repeatEvery: 60000,
        nextRun: Date.now() - 120_000,
        skipMissedOnRestart: true,
      }),
    ]);

    await tickScheduler(scheduler);

    expect(pushedJobs.length).toBe(0);

    const loaded = scheduler.list();
    expect(loaded[0].nextRun).toBeGreaterThan(Date.now());

    scheduler.stop();
  });
});
