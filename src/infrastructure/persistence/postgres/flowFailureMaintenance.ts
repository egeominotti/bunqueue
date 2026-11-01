import { safeTimeout, type SafeTimer } from '../../../shared/timers';
import type { PostgresContext } from './context';
import {
  postgresFlowFailureRepairDelay,
  recoverPostgresFlowFailures,
  repairPostgresMissingFlowFailures,
} from './flowFailureRepair';

/**
 * The pause between two slices of the legacy flow-parent repair pass. A slice reads
 * at most 1,000 dependency edges, so one broker reads at most about 4,000 edges/s.
 */
export const POSTGRES_FLOW_FAILURE_REPAIR_SLICE_MS = 250;

/** Runs one maintenance operation under a subsystem name; never rejects. */
export type PostgresMaintenanceRunner = (
  operation: () => Promise<unknown>,
  subsystem: string
) => Promise<void>;

/**
 * The runtime's flow-failure maintenance: the recovery sweep (at startup, preceded by
 * the first repair slice, and on every lease-recovery tick) and the rest of the
 * legacy repair pass. Each repair slice is armed only after the previous one
 * finished, `POSTGRES_FLOW_FAILURE_REPAIR_SLICE_MS` later (or when a retry after a
 * pass with errors is due), so slices never overlap or run back to back. Once the
 * pass completes cleanly no timer stays armed. `stop()` (shutdown or a fenced broker
 * session) cancels the armed timer and keeps a running slice from re-arming.
 */
export class PostgresFlowFailureMaintenance {
  private timer: SafeTimer | null = null;
  private running = false;

  constructor(
    private readonly ctx: PostgresContext,
    private readonly run: PostgresMaintenanceRunner
  ) {}

  /** The recovery sweep; at startup the first repair slice runs before it. */
  recover(startup: boolean): Promise<void> {
    const phase = startup ? 'startup' : 'tick';
    return this.run(() => recoverPostgresFlowFailures(this.ctx, phase), 'flow-failure-recovery');
  }

  /** Continue the repair pass in the background until it completes cleanly. */
  start(): void {
    this.running = true;
    this.arm();
  }

  stop(): void {
    this.running = false;
    this.timer?.clear();
    this.timer = null;
  }

  /** Whether a repair slice is scheduled. */
  get armed(): boolean {
    return this.timer !== null;
  }

  private arm(): void {
    if (!this.running || this.timer !== null) return;
    const wait = postgresFlowFailureRepairDelay(this.ctx);
    if (wait === null) return;
    this.timer = safeTimeout(
      () => void this.slice(),
      Math.max(POSTGRES_FLOW_FAILURE_REPAIR_SLICE_MS, wait)
    );
  }

  private async slice(): Promise<void> {
    this.timer = null;
    try {
      // The runner reports a failure to the health entry and resolves either way.
      await this.run(() => repairPostgresMissingFlowFailures(this.ctx), 'flow-failure-repair');
    } catch {
      // Defensive: a runner that rejected must not end the repair loop silently.
    } finally {
      this.arm();
    }
  }
}
