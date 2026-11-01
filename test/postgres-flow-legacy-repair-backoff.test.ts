/**
 * The PostgreSQL legacy flow-parent repair pass backs off after passes with errors
 * (60 s, doubling, capped at one hour) and keeps a database error that interrupts a
 * slice recorded until a pass completes cleanly. These run without a server: the
 * context's `sql` is a stand-in that fails or returns an empty edge page.
 */
import { describe, expect, test } from 'bun:test';
import type { PostgresContext } from '../src/infrastructure/persistence/postgres/context';
import {
  POSTGRES_FLOW_FAILURE_REPAIR_MAX_RETRY_MS,
  POSTGRES_FLOW_FAILURE_REPAIR_RETRY_MS,
  postgresFlowFailureRepairDelay,
  postgresFlowFailureRepairRetryMs,
  repairPostgresMissingFlowFailures,
} from '../src/infrastructure/persistence/postgres/flowFailureRepair';

/** A context whose queries fail while `failing.value` is true, else return no rows. */
function fakeContext(failing: { value: boolean }): PostgresContext {
  const sql = async (): Promise<unknown[]> => {
    if (failing.value) throw new Error('connection refused');
    return [];
  };
  return { config: { namespace: 'backoff-test' }, sql } as unknown as PostgresContext;
}

describe('PostgreSQL flow failure repair backoff', () => {
  test('the retry wait doubles after each failed pass and is capped at one hour', () => {
    expect(postgresFlowFailureRepairRetryMs(1)).toBe(POSTGRES_FLOW_FAILURE_REPAIR_RETRY_MS);
    expect(postgresFlowFailureRepairRetryMs(2)).toBe(2 * POSTGRES_FLOW_FAILURE_REPAIR_RETRY_MS);
    expect(postgresFlowFailureRepairRetryMs(3)).toBe(4 * POSTGRES_FLOW_FAILURE_REPAIR_RETRY_MS);
    expect(postgresFlowFailureRepairRetryMs(7)).toBe(POSTGRES_FLOW_FAILURE_REPAIR_MAX_RETRY_MS);
    expect(postgresFlowFailureRepairRetryMs(10_000)).toBe(
      POSTGRES_FLOW_FAILURE_REPAIR_MAX_RETRY_MS
    );
    expect(postgresFlowFailureRepairRetryMs(0)).toBe(POSTGRES_FLOW_FAILURE_REPAIR_RETRY_MS);
  });

  test('a database error mid-pass stays recorded until a pass completes cleanly', async () => {
    const failing = { value: true };
    const ctx = fakeContext(failing);
    await expect(repairPostgresMissingFlowFailures(ctx)).rejects.toThrow('connection refused');

    // The database is back: the pass reaches its last edge, but it was not clean,
    // so the retry is scheduled and the outage stays reported.
    failing.value = false;
    await expect(repairPostgresMissingFlowFailures(ctx)).rejects.toThrow('connection refused');
    const wait = postgresFlowFailureRepairDelay(ctx);
    expect(wait).not.toBeNull();
    expect(wait!).toBeGreaterThan(POSTGRES_FLOW_FAILURE_REPAIR_RETRY_MS - 1_000);
    expect(wait!).toBeLessThanOrEqual(POSTGRES_FLOW_FAILURE_REPAIR_RETRY_MS);
  });
});
