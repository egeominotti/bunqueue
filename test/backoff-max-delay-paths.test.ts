/**
 * backoff.maxDelay across every admission and reflection path.
 *
 * The repro (test/repro-backoff-max-delay.test.ts) covers the basic push,
 * SQLite restart and validator cases. This file pins the remaining surfaces:
 * defensive parsing for paths that skip the server validator (embedded, cron),
 * the TCP/HTTP handlers, atomic flows, repeat successors, cron-spawned jobs,
 * the real retry delay after FAIL, and the public `job.opts.backoff` shape.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { buildRepeatSuccessor } from '../src/application/repeatJobs';
import { validateAtomicFlowBatch } from '../src/application/operations/flowValidation';
import { QueueManager } from '../src/application/queueManager';
import { Queue, shutdownManager } from '../src/client';
import { buildJobOpts } from '../src/client/jobHelpers';
import {
  calculateBackoff,
  createJob,
  DEFAULT_MAX_BACKOFF,
  jobId,
  MAX_BACKOFF_DELAY,
  type Job,
  type JobInput,
} from '../src/domain/types/job';
import { handleCommand } from '../src/infrastructure/server/handler';
import { routeQueueJobOperations } from '../src/infrastructure/server/http-routes/queueJobs';
import { validateBackoffField } from '../src/infrastructure/server/protocol/validation';
import type { CronScheduler } from '../src/infrastructure/scheduler/cronScheduler';
import type { HandlerContext } from '../src/infrastructure/server/types';
import type { Command } from '../src/domain/types/command';

let manager: QueueManager | undefined;

afterEach(() => {
  manager?.shutdown();
  manager = undefined;
  shutdownManager();
});

function make(backoff: unknown, extra: Partial<JobInput> = {}): Job {
  return createJob(jobId('bmd-job'), 'bmd', { data: {}, backoff, ...extra } as JobInput);
}

function context(qm: QueueManager): HandlerContext {
  return { queueManager: qm, authTokens: new Set<string>(), authenticated: false };
}

describe('createJob keeps only a usable maxDelay', () => {
  test('drops malformed values instead of producing NaN or unbounded delays', () => {
    const invalid: unknown[] = [Number.NaN, Infinity, -1, 'soon', MAX_BACKOFF_DELAY + 1, null];
    for (const maxDelay of invalid) {
      const job = make({ type: 'exponential', delay: 1_000, maxDelay });
      expect(job.backoffConfig).toStrictEqual({ type: 'exponential', delay: 1_000 });
      const delay = calculateBackoff({ ...job, attempts: 30 });
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeLessThanOrEqual(DEFAULT_MAX_BACKOFF);
    }
  });

  test('keeps the inclusive bounds 0 and 24 hours', () => {
    const zero = make({ type: 'fixed', delay: 5_000, maxDelay: 0 });
    expect(zero.backoffConfig?.maxDelay).toBe(0);
    expect(calculateBackoff(zero)).toBe(0);

    const day = make({ type: 'exponential', delay: 1_000, maxDelay: MAX_BACKOFF_DELAY });
    expect(day.backoffConfig?.maxDelay).toBe(MAX_BACKOFF_DELAY);
    expect(calculateBackoff({ ...day, attempts: 40 })).toBeLessThanOrEqual(MAX_BACKOFF_DELAY);
  });

  test('a null backoff falls back to the numeric default instead of throwing', () => {
    const job = make(null);
    expect(job.backoffConfig).toBeNull();
    expect(job.backoff).toBe(1_000);
  });
});

describe('server validation of backoff.maxDelay', () => {
  test('accepts an omitted or null maxDelay and the inclusive bounds', () => {
    for (const maxDelay of [undefined, null, 0, 5_000, MAX_BACKOFF_DELAY]) {
      expect(validateBackoffField({ type: 'fixed', delay: 10, maxDelay })).toBeNull();
    }
  });

  test('rejects non-finite and out-of-range values with a named error', () => {
    // A numeric string ('5000') is its number since the 2.9.10-compatibility rules.
    for (const maxDelay of [Number.NaN, Infinity, -1, MAX_BACKOFF_DELAY + 1, 'soon']) {
      expect(validateBackoffField({ type: 'fixed', delay: 10, maxDelay })).toContain(
        'backoff.maxDelay'
      );
    }
  });

  test('PUSH stores a valid maxDelay and rejects an invalid one', async () => {
    manager = new QueueManager();
    const ctx = context(manager);
    const backoff = { type: 'exponential', delay: 1_000, maxDelay: 5_000 };
    const ok = await handleCommand(
      { cmd: 'PUSH', queue: 'bmd', data: {}, backoff } as Command,
      ctx
    );
    expect(ok.ok).toBe(true);
    const stored = await manager.getJob(jobId(String((ok as { id: string }).id)));
    expect(stored?.backoffConfig?.maxDelay).toBe(5_000);

    const bad = { ...backoff, maxDelay: -1 };
    const rejected = await handleCommand(
      { cmd: 'PUSH', queue: 'bmd', data: {}, backoff: bad } as Command,
      ctx
    );
    expect(rejected.ok).toBe(false);
    expect((rejected as { error: string }).error).toContain('backoff.maxDelay');
  });

  test('PUSHB names the offending job', async () => {
    manager = new QueueManager();
    const jobs = [
      { data: {}, backoff: { type: 'fixed', delay: 10, maxDelay: 20 } },
      { data: {}, backoff: { type: 'fixed', delay: 10, maxDelay: 'soon' } },
    ];
    const response = await handleCommand(
      { cmd: 'PUSHB', queue: 'bmd', jobs } as Command,
      context(manager)
    );
    expect(response.ok).toBe(false);
    expect((response as { error: string }).error).toContain('jobs[1]: backoff.maxDelay');
  });

  test('HTTP push returns 400 for an invalid maxDelay', async () => {
    manager = new QueueManager();
    const body = JSON.stringify({ data: {}, backoff: { type: 'fixed', delay: 1, maxDelay: -5 } });
    const request = new Request('http://localhost/queues/bmd/jobs', { method: 'POST', body });
    const response = await routeQueueJobOperations(
      request,
      '/queues/bmd/jobs',
      'POST',
      context(manager),
      new Set()
    );
    expect(response?.status).toBe(400);
  });

  test('atomic flow validation applies the same bounds', () => {
    const flow = (maxDelay: unknown) => ({
      jobs: [
        {
          id: jobId('bmd-flow-job'),
          queue: 'bmd',
          input: { data: {}, backoff: { type: 'fixed', delay: 10, maxDelay } } as JobInput,
        },
      ],
    });
    expect(() => validateAtomicFlowBatch(flow(5_000))).not.toThrow();
    expect(() => validateAtomicFlowBatch(flow(-1))).toThrow(/backoff\.maxDelay/);
  });
});

describe('maxDelay is carried by derived jobs and applied on retry', () => {
  test('a repeat successor inherits maxDelay', () => {
    const job = make(
      { type: 'exponential', delay: 1_000, maxDelay: 4_000 },
      { repeat: { every: 60_000, limit: 5 } }
    );
    const successor = buildRepeatSuccessor(job);
    expect(successor).not.toBeNull();
    const next = createJob(jobId('bmd-next'), 'bmd', successor!);
    expect(next.backoffConfig).toStrictEqual({
      type: 'exponential',
      delay: 1_000,
      maxDelay: 4_000,
    });
  });

  test('a cron-spawned job inherits maxDelay from jobOptions', async () => {
    manager = new QueueManager();
    manager.addCron({
      name: 'bmd-cron',
      queue: 'bmd-cron-q',
      data: {},
      repeatEvery: 30_000,
      immediately: true,
      jobOptions: { backoff: { type: 'fixed', delay: 100, maxDelay: 50 } },
    });
    const scheduler = (manager as unknown as { cronScheduler: CronScheduler }).cronScheduler;
    await (scheduler as unknown as { tick(): Promise<void> }).tick();
    const jobs = manager.getJobs('bmd-cron-q', { state: ['waiting', 'prioritized'] });
    expect(jobs.length).toBe(1);
    expect(jobs[0].backoffConfig?.maxDelay).toBe(50);
  });

  test('FAIL schedules the retry no later than maxDelay', async () => {
    manager = new QueueManager();
    const backoff = { type: 'exponential', delay: 60_000, maxDelay: 2_000 } as const;
    await manager.push('bmd-retry', { data: {}, maxAttempts: 5, backoff });
    const pulled = await manager.pull('bmd-retry');
    expect(pulled).not.toBeNull();
    await manager.fail(pulled!.id, 'boom');
    const after = Date.now();
    const retried = await manager.getJob(pulled!.id);
    expect(await manager.getJobState(pulled!.id)).toBe('delayed');
    // Uncapped, attempt 1 would wait at least 60 seconds.
    expect(retried!.runAt).toBeLessThanOrEqual(after + 2_000);
  });
});

describe('public job.opts.backoff', () => {
  test('buildJobOpts includes maxDelay only when the job has one', () => {
    const capped = make({ type: 'exponential', delay: 500, maxDelay: 3_000 });
    expect(buildJobOpts(capped).backoff).toStrictEqual({
      type: 'exponential',
      delay: 500,
      maxDelay: 3_000,
    });
    const uncapped = make({ type: 'fixed', delay: 500 });
    expect(buildJobOpts(uncapped).backoff).toStrictEqual({ type: 'fixed', delay: 500 });
  });

  test('an embedded Queue round-trips maxDelay through add and getJob', async () => {
    const queue = new Queue('bmd-client-opts', { embedded: true });
    const backoff = { type: 'exponential' as const, delay: 100, maxDelay: 500 };
    const added = await queue.add('task', {}, { backoff });
    const fetched = await queue.getJob(added.id);
    expect(fetched?.opts.backoff).toEqual(backoff);
    await queue.close();
  });
});
