/**
 * Units behind the PostgreSQL timer fixes: lease deadlines for any duration and the
 * maintenance cadences derived from the configuration. No database is needed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  POSTGRES_NEVER_EXPIRES_MS,
  postgresClaimLeaseUntil,
  postgresLeaseDeadline,
  postgresLeaseUntil,
  postgresRequestedLeaseMs,
  postgresStallTimeoutCap,
} from '../src/infrastructure/persistence/postgres/leaseDeadline';
import {
  PostgresMaintenanceSchedule,
  postgresBrokerHeartbeatMs,
  postgresLeaseRecoveryMs,
} from '../src/infrastructure/persistence/postgres/maintenanceSchedule';
import { eventually } from './support/postgres-event-race';

const NOW = 1_791_000_000_000;
const anyNumber = fc.oneof(
  fc.double(),
  fc.constantFrom(Number.NaN, Infinity, -Infinity, -0, 0, Number.MAX_SAFE_INTEGER, 2 ** 31),
  fc.integer({ min: -1_000_000, max: 1_000_000_000 })
);
const anyStored = fc.oneof(anyNumber, fc.constantFrom(null, undefined, '5000', {}));
const schedules: PostgresMaintenanceSchedule[] = [];

afterEach(() => {
  for (const schedule of schedules.splice(0)) schedule.stop();
});

describe('PostgreSQL lease deadlines', () => {
  test('every claim deadline is a whole, readable millisecond at least 1 ms ahead', () => {
    fc.assert(
      fc.property(anyNumber, anyStored, anyStored, (requested, timeout, stallTimeout) => {
        const leaseMs = postgresRequestedLeaseMs(requested, 30_000);
        const deadline = postgresClaimLeaseUntil(NOW, leaseMs, { timeout, stallTimeout });
        expect(Number.isSafeInteger(deadline)).toBe(true);
        expect(deadline).toBeGreaterThanOrEqual(NOW + 1);
        expect(deadline).toBeLessThanOrEqual(POSTGRES_NEVER_EXPIRES_MS);
      }),
      { numRuns: 2_000 }
    );
  });

  test('a requested lease is whole milliseconds; NaN means the configured lease', () => {
    expect(postgresRequestedLeaseMs(30_000, 45_000)).toBe(30_000);
    expect(postgresRequestedLeaseMs(30_000.2, 45_000)).toBe(30_001);
    expect(postgresRequestedLeaseMs(Number.NaN, 45_000)).toBe(45_000);
    expect(postgresRequestedLeaseMs(undefined, 45_000)).toBe(45_000);
    expect(postgresRequestedLeaseMs('60000', 45_000)).toBe(45_000);
    expect(postgresRequestedLeaseMs(0, 45_000)).toBe(1);
    expect(postgresRequestedLeaseMs(-Infinity, 45_000)).toBe(1);
    expect(postgresRequestedLeaseMs(Infinity, 45_000)).toBe(Infinity);
  });

  test('deadlines clamp to the readable range; NaN expires at once', () => {
    expect(postgresLeaseDeadline(NOW, 1500.5)).toBe(NOW + 1501);
    expect(postgresLeaseDeadline(NOW, Infinity)).toBe(POSTGRES_NEVER_EXPIRES_MS);
    expect(postgresLeaseDeadline(NOW, Number.MAX_SAFE_INTEGER)).toBe(POSTGRES_NEVER_EXPIRES_MS);
    expect(postgresLeaseDeadline(NOW, -1e18)).toBe(0);
    expect(postgresLeaseDeadline(NOW, -Infinity)).toBe(0);
    expect(postgresLeaseDeadline(NOW, Number.NaN)).toBe(0);
  });

  test('timeouts follow the shared rule: 0 and NaN mean none, negatives are due', () => {
    for (const none of [null, undefined, 0, -0, Number.NaN, '5000']) {
      expect(postgresClaimLeaseUntil(NOW, 30_000, { timeout: none, stallTimeout: null })).toBe(
        NOW + 30_000
      );
    }
    expect(postgresClaimLeaseUntil(NOW, 30_000, { timeout: 5_000, stallTimeout: null })).toBe(
      NOW + 5_000
    );
    // A renewal never outlives the generation's deadline; a due one is not extended.
    expect(
      postgresLeaseUntil(NOW, 30_000, NOW - 10_000, { timeout: 15_000, stallTimeout: null })
    ).toBe(NOW + 5_000);
    expect(
      postgresLeaseUntil(NOW, 30_000, NOW - 10_000, { timeout: 5_000, stallTimeout: null })
    ).toBe(NOW - 5_000);
    expect(postgresClaimLeaseUntil(NOW, 30_000, { timeout: -5, stallTimeout: null })).toBe(NOW + 1);
    expect(postgresClaimLeaseUntil(NOW, 30_000, { timeout: 5_000, stallTimeout: 2_000 })).toBe(
      NOW + 2_000
    );
  });

  test('stall timeouts: NaN means none, 0 stalls at once as in the core engine', () => {
    expect(postgresStallTimeoutCap(Number.NaN)).toBeNull();
    expect(postgresStallTimeoutCap(null)).toBeNull();
    expect(postgresStallTimeoutCap(0)).toBe(0);
    expect(postgresClaimLeaseUntil(NOW, 30_000, { timeout: null, stallTimeout: 0 })).toBe(NOW + 1);
    expect(postgresClaimLeaseUntil(NOW, 30_000, { timeout: null, stallTimeout: Number.NaN })).toBe(
      NOW + 30_000
    );
  });
});

describe('PostgreSQL maintenance cadences', () => {
  test('keep the documented formulas', () => {
    expect(postgresBrokerHeartbeatMs({ leaseDurationMs: 30_000 })).toBe(10_000);
    expect(postgresLeaseRecoveryMs({ leaseDurationMs: 30_000 })).toBe(15_000);
    expect(postgresBrokerHeartbeatMs({ leaseDurationMs: 1_000 })).toBe(1_000);
    expect(postgresLeaseRecoveryMs({ leaseDurationMs: 1_000 })).toBe(500);
    expect(postgresBrokerHeartbeatMs({ leaseDurationMs: 6_500_000_000 })).toBe(2_166_666_666);
  });

  test('scan for expired leases at least every 15 s, whatever the lease length', () => {
    // A long broker lease must not delay recovery of short lock TTLs and job timeouts.
    expect(postgresLeaseRecoveryMs({ leaseDurationMs: 3_600_000 })).toBe(15_000);
    expect(postgresLeaseRecoveryMs({ leaseDurationMs: 6_500_000_000 })).toBe(15_000);
    expect(postgresLeaseRecoveryMs({ leaseDurationMs: Number.MAX_SAFE_INTEGER })).toBe(15_000);
    expect(postgresLeaseRecoveryMs({ leaseDurationMs: 10_000 })).toBe(5_000);
  });

  test('run short periods, replace an earlier schedule and stop every task', async () => {
    const schedule = new PostgresMaintenanceSchedule();
    schedules.push(schedule);
    const ticks = { heartbeat: 0, recovery: 0, sweeps: 0, cron: 0 };
    const tasks = {
      heartbeat: () => ticks.heartbeat++,
      recovery: () => ticks.recovery++,
      sweeps: () => ticks.sweeps++,
      cron: () => ticks.cron++,
    };
    const config = { leaseDurationMs: 6_500_000_000, pollIntervalMs: 10 };
    const armed = () => (Reflect.get(schedule, 'timers') as unknown[]).length;

    schedule.start(config, tasks);
    schedule.start(config, tasks);
    expect(armed()).toBe(4);
    expect(await eventually(() => ticks.cron >= 2)).toBe(true);
    schedule.stop();
    schedule.stop();
    const stopped = { ...ticks };
    await Bun.sleep(30);

    expect(armed()).toBe(0);
    expect(ticks).toEqual(stopped);
    expect({ ...ticks, cron: 0 }).toEqual({ heartbeat: 0, recovery: 0, sweeps: 0, cron: 0 });
  });
});
