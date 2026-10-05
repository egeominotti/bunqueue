/**
 * One processing-timeout rule for the broker and the Worker.
 *
 * The Worker abandons the outcome of a job its own timer aborted and leaves the
 * broker's timeout transition to settle it, so arming a timer the broker does not
 * enforce leaves the job `active` for good. Both sides therefore take the rule from
 * one domain module, `src/domain/job/timeoutRule.ts`: the broker's scheduler
 * registers `processingDeadline(job)` and the Worker arms
 * `processingTimeoutDelay(job)`. These tests pin the rule, check the real scheduler
 * registers exactly that deadline, and check that neither side keeps a copy of its own.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JobTimeoutScheduler } from '../src/application/background/timeouts';
import type { BackgroundContext } from '../src/application/types';
import { jobId, type Job, type JobId } from '../src/domain/types/job';

const ROOT = join(import.meta.dir, '..');
const RULE_MODULE = '../src/domain/job/timeoutRule';
const STARTED_AT = 1_700_000_000_000;

interface TimeoutRule {
  NEVER_DEADLINE: number;
  processingDeadline(job: Pick<Job, 'timeout' | 'startedAt'>): number | null;
  processingTimeoutDelay(job: Pick<Job, 'timeout' | 'startedAt'>): number | null;
}

const loadRule = async (): Promise<TimeoutRule> => (await import(RULE_MODULE)) as TimeoutRule;
const source = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/** Every shape a stored `timeout` can take: producers validate it, the broker does not. */
const TIMEOUTS = [
  0,
  -0,
  Number.NaN,
  1,
  40,
  0.5,
  1_500.25,
  -5,
  -0.5,
  86_400_000,
  3_000_000_000,
  Number.MAX_SAFE_INTEGER,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

describe('the shared processing-timeout rule', () => {
  test.each([
    [null, null, null],
    [0, null, null],
    [Number.NaN, null, null],
    [40, STARTED_AT + 40, 40],
    [3_000_000_000, STARTED_AT + 3_000_000_000, 3_000_000_000],
    [0.5, STARTED_AT + 1, 1],
    [1_500.25, STARTED_AT + 1_501, 1_501],
    [-5, STARTED_AT - 5, -5],
    [-0.5, STARTED_AT, 0],
    [Number.MAX_SAFE_INTEGER, 'never', null],
    [Number.POSITIVE_INFINITY, 'never', null],
    [Number.NEGATIVE_INFINITY, 'never', null],
  ])('timeout %p: deadline %p, Worker delay %p', async (timeout, deadline, delay) => {
    const rule = await loadRule();
    const job = { timeout, startedAt: STARTED_AT };
    expect(rule.processingDeadline(job)).toBe(
      deadline === 'never' ? rule.NEVER_DEADLINE : (deadline as number | null)
    );
    expect(rule.processingTimeoutDelay(job)).toBe(delay);
  });

  test('an unstarted job has no deadline', async () => {
    const rule = await loadRule();
    expect(rule.processingDeadline({ timeout: 40, startedAt: null })).toBeNull();
    expect(rule.processingTimeoutDelay({ timeout: 40, startedAt: null })).toBeNull();
  });
});

describe('the broker scheduler registers exactly the shared deadline', () => {
  interface SchedulerView {
    active: Map<JobId, { deadline: number }>;
  }

  function registeredDeadline(timeout: number): number | null {
    const scheduler = new JobTimeoutScheduler();
    const context = {
      jobIndex: new Map(),
      processingShards: [],
      config: { jobTimeoutCheckMs: 5_000 },
    } as unknown as BackgroundContext;
    scheduler.start(context);
    try {
      const id = jobId('timeout-rule');
      scheduler.schedule({ id, timeout, startedAt: STARTED_AT } as unknown as Job);
      return (scheduler as unknown as SchedulerView).active.get(id)?.deadline ?? null;
    } finally {
      scheduler.stop();
    }
  }

  test.each(TIMEOUTS.map((timeout) => [timeout]))('timeout %p', async (timeout) => {
    const rule = await loadRule();
    const job = { timeout, startedAt: STARTED_AT };
    expect(registeredDeadline(timeout)).toBe(rule.processingDeadline(job));
    const delay = rule.processingTimeoutDelay(job);
    const deadline = rule.processingDeadline(job);
    // The Worker arms a timer exactly when the broker enforces a reachable deadline.
    expect(delay === null ? null : STARTED_AT + delay).toBe(
      deadline === rule.NEVER_DEADLINE ? null : deadline
    );
  });
});

describe('both sides import the one rule and keep no copy', () => {
  test('the broker scheduler uses processingDeadline', () => {
    const scheduler = source('src/application/background/timeouts.ts');
    expect(scheduler).toContain("from '../../domain/job/timeoutRule'");
    expect(scheduler).toContain('processingDeadline(');
    expect(scheduler).not.toMatch(/function deadlineFor\b/);
    expect(scheduler).not.toMatch(/startedAt \+ [a-z.]*timeout/);
  });

  test('automatic and manual Worker processing use processingTimeoutDelay', () => {
    for (const path of [
      'src/client/worker/runtime/execution.ts',
      'src/client/worker/runtime/manual.ts',
    ]) {
      const worker = source(path);
      expect(worker).toContain("from '../../../domain/job/timeoutRule'");
      expect(worker).toContain('processingTimeoutDelay(');
    }
    expect(Bun.file(join(ROOT, 'src/client/worker/jobTimeout.ts')).size).toBe(0);
  });
});
