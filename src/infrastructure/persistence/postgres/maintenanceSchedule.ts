import { safeInterval, type SafeTimer } from '../../../shared/timers';
import type { ResolvedPostgresStorageConfig } from './types';

type CadenceConfig = Pick<ResolvedPostgresStorageConfig, 'leaseDurationMs' | 'pollIntervalMs'>;

/** How often a broker refreshes its heartbeat row: a third of the lease, at least 1 s. */
export function postgresBrokerHeartbeatMs(config: Pick<CadenceConfig, 'leaseDurationMs'>): number {
  return Math.max(1000, Math.floor(config.leaseDurationMs / 3));
}

/**
 * The longest gap between expired-lease scans: the scan interval of the default
 * 30 s lease. Lock TTLs and job timeouts are often shorter than the broker lease, so
 * a long `leaseDurationMs` must not delay their recovery by half that lease.
 */
const POSTGRES_MAX_RECOVERY_SCAN_MS = 15_000;

/** How often expired processing leases are scanned: half the lease, within [500 ms, 15 s]. */
export function postgresLeaseRecoveryMs(config: Pick<CadenceConfig, 'leaseDurationMs'>): number {
  const half = Math.max(500, Math.floor(config.leaseDurationMs / 2));
  return half < POSTGRES_MAX_RECOVERY_SCAN_MS ? half : POSTGRES_MAX_RECOVERY_SCAN_MS;
}

/** The fixed cadence of the DLQ, worker/broker purge and retention sweeps. */
const POSTGRES_PERIODIC_SWEEP_MS = 60_000;

/**
 * The longest wait before failed post-commit maintenance, a projection load or a
 * queue refresh is retried: the cap of the queue-refresh backoff.
 */
export const POSTGRES_MAX_RETRY_DELAY_MS = 1_000;

/** Retry delays follow `pollIntervalMs` (250 ms by default) but never exceed 1 s. */
export function postgresRetryDelayMs(config: Pick<CadenceConfig, 'pollIntervalMs'>): number {
  return Math.min(config.pollIntervalMs, POSTGRES_MAX_RETRY_DELAY_MS);
}

/** The runtime's periodic maintenance tasks. */
export interface PostgresMaintenanceTasks {
  /** Every `postgresBrokerHeartbeatMs`. */
  readonly heartbeat: () => void;
  /** Every `postgresLeaseRecoveryMs`. */
  readonly recovery: () => void;
  /** Every `POSTGRES_PERIODIC_SWEEP_MS`. */
  readonly sweeps: () => void;
  /** Every `pollIntervalMs`. */
  readonly cron: () => void;
}

/**
 * The runtime's periodic maintenance. Periods derive from `leaseDurationMs` and
 * `pollIntervalMs`, which may exceed the native timer limit (2^31 - 1 ms, about
 * 24.8 days), so every task is a `safeInterval`: a long period is honoured instead
 * of collapsing into a 1 ms spin.
 */
export class PostgresMaintenanceSchedule {
  private timers: SafeTimer[] = [];

  /** Arm every task, replacing any earlier schedule. */
  start(config: CadenceConfig, tasks: PostgresMaintenanceTasks): void {
    this.stop();
    const periods: Array<[number, () => void]> = [
      [postgresBrokerHeartbeatMs(config), tasks.heartbeat],
      [postgresLeaseRecoveryMs(config), tasks.recovery],
      [POSTGRES_PERIODIC_SWEEP_MS, tasks.sweeps],
      [config.pollIntervalMs, tasks.cron],
    ];
    for (const [periodMs, run] of periods) this.timers.push(safeInterval(run, periodMs));
  }

  /** Cancel every task. Idempotent, and safe from inside a task. */
  stop(): void {
    for (const timer of this.timers) timer.clear();
    this.timers = [];
  }
}
