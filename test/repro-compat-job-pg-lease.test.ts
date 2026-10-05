/**
 * Repro (2.9.10 compatibility): PostgreSQL lease renewals were capped at stallTimeout.
 *
 * 2.9.10 shortened only a claim to the job's `stallTimeout`; a renewal (ExtendLock,
 * JobHeartbeat with a duration) granted the requested lease, capped only by the job's
 * processing deadline. The candidate applied the stall cap to renewals too, so a
 * Worker whose heartbeat interval exceeds the job's stallTimeout (lockDuration 30 s,
 * stallTimeout 10 s) now loses its lease between heartbeats and the job is recovered as
 * stalled while it is still running. The renewal must keep 2.9.10's caps while
 * keeping the candidate's whole-millisecond and valid-date-range fixes.
 */
import { describe, expect, test } from 'bun:test';
import {
  POSTGRES_NEVER_EXPIRES_MS,
  postgresClaimLeaseUntil,
  postgresLeaseUntil,
} from '../src/infrastructure/persistence/postgres/leaseDeadline';

const NOW = 1_700_000_000_000;

describe('PostgreSQL lease renewal keeps the 2.9.10 caps', () => {
  test('a renewal is not shortened to the stall timeout', () => {
    expect(
      postgresLeaseUntil(NOW, 30_000, NOW - 5_000, { timeout: null, stallTimeout: 10_000 })
    ).toBe(NOW + 30_000);
  });

  test('a renewal still ends at the processing deadline', () => {
    expect(
      postgresLeaseUntil(NOW, 30_000, NOW - 5_000, { timeout: 15_000, stallTimeout: 10_000 })
    ).toBe(NOW + 10_000);
  });

  test('a renewal keeps whole milliseconds and the never-expires clamp', () => {
    expect(postgresLeaseUntil(NOW, 1_500.5, NOW, { timeout: null, stallTimeout: 1 })).toBe(
      NOW + 1_501
    );
    expect(
      postgresLeaseUntil(NOW, Number.POSITIVE_INFINITY, NOW, { timeout: null, stallTimeout: 1 })
    ).toBe(POSTGRES_NEVER_EXPIRES_MS);
  });

  test('a claim is still shortened to the stall timeout, as on 2.9.10', () => {
    expect(postgresClaimLeaseUntil(NOW, 30_000, { timeout: null, stallTimeout: 10_000 })).toBe(
      NOW + 10_000
    );
  });
});
