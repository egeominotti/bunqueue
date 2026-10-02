/**
 * WaitExpiry — the timeout side of a timed `waitFor`, decided as one claim.
 *
 * A timed gate has two possible exits and two independent drivers: the worker that
 * re-enters the node once the budget is spent, and whoever delivers the signal. The
 * signaller may be another connection entirely (a second app process, or the MCP
 * `bunqueue_signal_workflow` tool, which records through its own SignalCoordinator and
 * then publishes the resume job itself), so nothing in this process can serialise it.
 *
 * The worker used to decide in two steps: re-read the row, find no signal, and then
 * write `failed` from its in-memory snapshot. A signal recorded between the two was
 * accepted with `resumed: true` (the row was still `waiting`, so record() claimed the
 * resume), the signaller published the resume job, and the failing write then
 * overwrote the run and compensated: the approver was told the run continued while it
 * had failed (test/repro-workflow-signal-timeout-race.test.ts).
 *
 * So the expiry is a claim like every other transition that pairs with a signal: the
 * signal check and the failing write happen in one IMMEDIATE transaction, the same
 * write reservation record() takes. Whichever commits first decides, at the database:
 *
 *   - expiry first: the row is `failed`, so record() rejects the late signal with
 *     "cannot receive the signal" and nobody is told the run continues;
 *   - signal first: the expiry sees the key and writes nothing, so no failure is
 *     persisted and the caller advances past the gate instead.
 *
 * This deliberately does not touch the `signals` column, which stays owned by
 * SignalCoordinator (storeSignals.ts). It only reads it, inside the reservation.
 */

import type { Database } from 'bun:sqlite';
import { isLive } from './admission';
import { pack, unpack } from './storeCodec';
import { packExecutionMeta } from './storeExecutionCodec';
import { hasSignal } from './storeSignals';
import type { Execution } from './types';
import { clock } from './clock';

export type WaitExpiryOutcome =
  /** This caller failed the run and now owns its rollback. */
  | { kind: 'expired' }
  /** The signal won the race; nothing was written, so advance past the gate. */
  | { kind: 'signalled'; signals: Record<string, unknown> }
  /** Another driver moved the run off this gate; neither fail nor advance it. */
  | { kind: 'moved' };

export class WaitExpiry {
  private readonly read: ReturnType<Database['prepare']>;
  private readonly fail: ReturnType<Database['prepare']>;

  constructor(private readonly db: Database) {
    this.read = db.prepare(
      `SELECT state, current_node_index, signals FROM workflow_executions WHERE id = ?`
    );
    // The predicate repeats what the transaction has just checked. Inside the
    // reservation it cannot disagree, but it keeps the statement a claim on its own
    // rather than a write that is only safe because of the code around it.
    this.fail = db.prepare(
      `UPDATE workflow_executions
       SET state = 'failed', steps = ?, resolved_steps = ?, updated_at = ?, meta = ?
       WHERE id = ? AND state IN ('running', 'waiting') AND current_node_index = ?`
    );
  }

  /**
   * Persist `failed` (the step-level columns of `failed`) for the gate at `nodeIndex`,
   * but only while the run is still live on that node and `event` has not arrived.
   *
   * `failed` is the caller's snapshot with the failure already applied. The caller
   * keeps its own copy untouched until this returns `expired`, because on any other
   * outcome that copy is still the run it must advance or leave alone.
   */
  claim(failed: Execution, event: string, nodeIndex: number): WaitExpiryOutcome {
    const tx = this.db.transaction((): WaitExpiryOutcome => {
      const row = this.read.get(failed.id) as Record<string, unknown> | null;
      // The cursor and liveness come before the signal: a run another driver already
      // advanced (or finished) also carries the signal, and treating that as
      // `signalled` would advance it a second time.
      if (!row || row.current_node_index !== nodeIndex) return { kind: 'moved' };
      if (!isLive(row.state as Execution['state'])) return { kind: 'moved' };

      const signals =
        (unpack(row.signals as Uint8Array | null) as Record<string, unknown> | null) ?? {};
      if (hasSignal(signals, event)) return { kind: 'signalled', signals };

      failed.updatedAt = clock().now();
      const written = this.fail.run(
        pack(failed.steps),
        failed.resolvedSteps ? pack(failed.resolvedSteps) : null,
        failed.updatedAt,
        packExecutionMeta(failed),
        failed.id,
        nodeIndex
      ) as { changes: number };
      return written.changes === 1 ? { kind: 'expired' } : { kind: 'moved' };
    });
    // IMMEDIATE for the same reason as record() and park(): taking the write
    // reservation before the read serialises this check against record() across
    // connections. A deferred transaction lets both sides read first, and the loser
    // then surfaces SQLITE_BUSY while upgrading instead of waiting and re-reading.
    return tx.immediate();
  }
}
