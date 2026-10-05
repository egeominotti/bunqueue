/**
 * PostgreSQL follows the one processing-timeout rule.
 *
 * The SQLite scheduler and the Worker take the job timeout from
 * `src/domain/job/timeoutRule.ts` (`processingDeadline`); see
 * `test/worker-job-timeout-rule.test.ts`. The PostgreSQL engine enforces the same
 * timeout through its lease: a claim and a renewal end no later than the processing
 * deadline, and recovery reports a timeout once that deadline is due. These tests pin
 * that both use exactly the shared deadline, only bounded by PostgreSQL's own lease
 * rules (whole milliseconds, a claim of at least 1 ms, the never-expires clamp), and
 * that neither module keeps a copy of the rule.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NEVER_DEADLINE, processingDeadline } from '../src/domain/job/timeoutRule';
import {
  POSTGRES_NEVER_EXPIRES_MS,
  postgresClaimLeaseUntil,
  postgresLeaseUntil,
  postgresRequestedLeaseMs,
} from '../src/infrastructure/persistence/postgres/leaseDeadline';

const ROOT = join(import.meta.dir, '..');
const STARTED_AT = 1_700_000_000_000;
/** A request that would never expire, so only the timeout can shorten the lease. */
const UNBOUNDED_LEASE = postgresRequestedLeaseMs(Number.POSITIVE_INFINITY, 30_000);
const source = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/** The same shapes `worker-job-timeout-rule.test.ts` pins, plus stored non-numbers. */
const TIMEOUTS: unknown[] = [
  null,
  undefined,
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
  '5000',
];

/** The shared deadline as a PostgreSQL lease bound: none or never means no cap. */
function sharedCap(timeout: unknown, startedAt: number): number | null {
  const deadline = processingDeadline({ timeout: timeout as number | null, startedAt });
  return deadline === null || deadline === NEVER_DEADLINE ? null : deadline;
}

describe('PostgreSQL leases end at the shared processing deadline', () => {
  test.each(TIMEOUTS.map((timeout) => [timeout]))('claim with timeout %p', (timeout) => {
    const cap = sharedCap(timeout, STARTED_AT);
    const leaseUntil = postgresClaimLeaseUntil(STARTED_AT, UNBOUNDED_LEASE, {
      timeout,
      stallTimeout: null,
    });
    const expected = cap === null ? POSTGRES_NEVER_EXPIRES_MS : Math.max(STARTED_AT + 1, cap);
    expect(leaseUntil).toBe(expected);
  });

  test.each(TIMEOUTS.map((timeout) => [timeout]))('renewal with timeout %p', (timeout) => {
    const now = STARTED_AT + 10_000;
    const cap = sharedCap(timeout, STARTED_AT);
    const leaseUntil = postgresLeaseUntil(now, UNBOUNDED_LEASE, STARTED_AT, {
      timeout,
      stallTimeout: null,
    });
    const expected = cap === null ? POSTGRES_NEVER_EXPIRES_MS : Math.max(0, cap);
    expect(leaseUntil).toBe(expected);
  });
});

describe('the PostgreSQL engine imports the one rule and keeps no copy', () => {
  test('lease deadlines and recovery use processingDeadline', () => {
    for (const path of [
      'src/infrastructure/persistence/postgres/leaseDeadline.ts',
      'src/infrastructure/persistence/postgres/recovery.ts',
    ]) {
      const module = source(path);
      expect(module).toContain("from '../../../domain/job/timeoutRule'");
      expect(module).toContain('processingDeadline(');
      expect(module).not.toMatch(/startedAt \+ [a-z.]*timeout/);
      expect(module).not.toMatch(/postgresJobTimeoutCap/);
    }
  });

  test('renewal and claim derive their caps from leaseDeadline.ts only', () => {
    for (const path of [
      'src/infrastructure/persistence/postgres/leaseRenewal.ts',
      'src/infrastructure/persistence/postgres/claimBatch.ts',
    ]) {
      const module = source(path);
      expect(module).toContain("from './leaseDeadline'");
      expect(module).not.toMatch(/\.timeout\b/);
    }
  });
});
