/**
 * waitFor node execution — parking a run for a human/external signal, and the
 * timeout timers that bound the wait.
 *
 * Split out of the executor because parking is the one node type with a genuinely
 * concurrent counterpart: `signal()` mutates the same row from outside the worker,
 * so every transition here has to be expressed as a claim against the store rather
 * than an in-memory state change. See storeSignals.ts for the ownership rules.
 */

import type { Queue } from '../queue/queue';
import type { Workflow } from './workflow';
import type { WorkflowStore } from './store';
import type { WorkflowEmitter } from './emitter';
import type { Execution, StepJobData, WorkflowNode } from './types';
import { WaitForSignalError } from './compensator';
import { hasSignal } from './storeSignals';
import { clock, type TimerHandle } from './clock';
import { clampTimerDelay } from '../../shared/timers';

const TIMEOUT_ENQUEUE_RETRY_MS = 5_000;

export interface TimerDeps {
  queue: Queue;
  timers: Map<string, TimerHandle>;
  assertActive: () => void;
  isActive: () => boolean;
}

export interface WaitForDeps {
  store: WorkflowStore;
  emitter: WorkflowEmitter | null;
  advance: (exec: Execution, nextIdx: number, wf: Workflow) => Promise<void>;
  compensate: (exec: Execution, wf: Workflow) => Promise<void>;
  scheduleTimeoutCheck: (execId: string, workflowName: string, nodeIdx: number, ms: number) => void;
  updateFn: (exec: Execution) => void;
  assertActive: () => void;
}

/**
 * Arm the timer that re-enters a parked node once its wait budget elapses.
 *
 * setTimeout takes a 32-bit signed delay; anything larger wraps to 1ms and fires
 * immediately (`TimeoutOverflowWarning`). Clamping (`clampTimerDelay`, shared/timers.ts)
 * and letting the re-check job re-arm for whatever remains is what makes multi-week
 * approval windows survive (test/repro-workflow-timeout-overflow.test.ts). The timer
 * goes through the engine clock, so a simulated clock still drives it.
 */
export function scheduleTimeoutCheck(
  deps: TimerDeps,
  execId: string,
  workflowName: string,
  nodeIdx: number,
  ms: number
): void {
  const arm = (requestedDelay: number): void => {
    deps.assertActive();
    // NaN (a wait start that is not a number) re-checks at once, and runWaitFor then
    // fails the gate; clampTimerDelay would throw out of recovery or a timer callback.
    const delay = requestedDelay > 0 ? clampTimerDelay(requestedDelay) : 0;
    // Replacing a live timer for the same execution — re-entering a waitFor node used
    // to leak the previous one, which then fired against a node the run had left.
    const previous = deps.timers.get(execId);
    if (previous) clock().clearTimeout(previous);

    const timer = clock().setTimeout(() => {
      if (!deps.isActive()) {
        if (deps.timers.get(execId) === timer) deps.timers.delete(execId);
        return;
      }
      const jobData: StepJobData = { executionId: execId, workflowName, nodeIndex: nodeIdx };
      const published = (): void => {
        // Keep the handle in the map while add() is pending. signal() and close() use
        // deletion as cancellation; a late rejection must not resurrect their timer.
        if (deps.timers.get(execId) === timer) deps.timers.delete(execId);
      };
      const failed = (): void => {
        if (deps.timers.get(execId) !== timer) return;
        if (!deps.isActive()) {
          deps.timers.delete(execId);
          return;
        }
        arm(TIMEOUT_ENQUEUE_RETRY_MS);
      };

      try {
        deps.queue
          .add('wf:step', jobData as unknown as Record<string, unknown>)
          .then(published, failed);
      } catch {
        failed();
      }
    }, delay);
    // A parked approval gate is a normal steady state. unref keeps its timer
    // functional without making it the reason the process remains alive.
    timer.unref?.();
    deps.timers.set(execId, timer);
  };

  arm(ms);
}

/**
 * Cancel every armed wait timer. Called on engine shutdown: `unref` alone lets a
 * process exit, but a still-armed timer can also fire into a queue that is closing,
 * and a caller that shuts one engine down while keeping the process alive has no
 * other way to release them.
 */
export function clearTimers(timers: Map<string, TimerHandle>): void {
  for (const timer of timers.values()) clock().clearTimeout(timer);
  timers.clear();
}

/**
 * Execute a `waitFor` node: advance if the signal is already there, fail if the wait
 * has expired, otherwise park the run and throw the sentinel so processStep
 * short-circuits without treating the pause as an error.
 */
export async function runWaitFor(
  deps: WaitForDeps,
  exec: Execution,
  node: Extract<WorkflowNode, { type: 'waitFor' }>,
  idx: number,
  wf: Workflow
): Promise<void> {
  deps.assertActive();
  if (hasSignal(exec.signals, node.event)) {
    await deps.advance(exec, idx + 1, wf);
    return;
  }

  const waitKey = `__waitFor:${node.event}`;
  let remaining = 0;
  if (node.timeout !== undefined) {
    const existing = exec.steps[waitKey] as { startedAt?: number } | undefined;
    const waitingSince = existing?.startedAt ?? clock().now();
    if (!existing) exec.steps[waitKey] = { status: 'running', startedAt: waitingSince };

    const elapsed = clock().now() - waitingSince;
    if (!Number.isFinite(elapsed) || elapsed >= node.timeout) {
      // A start that is not a finite number (a corrupted row) leaves the budget
      // unmeasurable: fail the gate through the same claim rather than park it behind
      // a NaN timer that would re-check forever.
      const reason = Number.isFinite(elapsed)
        ? undefined
        : `Signal "${node.event}" wait has an invalid start time (${String(waitingSince)}); ` +
          `its ${node.timeout}ms budget cannot be measured`;
      await expireGate(deps, exec, wf, { node, idx, waitingSince, reason });
      return;
    }
    deps.updateFn(exec);
    remaining = node.timeout - (clock().now() - waitingSince);
  }

  // Park transactionally. Between the in-memory check above and this point a signal
  // can land: it would be recorded with no parked run left to claim the resume,
  // hanging the execution forever. parkForSignal() re-reads the persisted signals
  // and only transitions 'running' -> 'waiting' when none has arrived.
  deps.assertActive();
  const park = deps.store.parkForSignal(exec.id, node.event);
  if (park.signalPresent) {
    exec.signals = park.signals;
    await deps.advance(exec, idx + 1, wf);
    return;
  }
  if (!park.parked) {
    // Another job already moved this execution off 'running'; don't advance or emit
    // a second waiting event for the same node.
    throw new WaitForSignalError(node.event);
  }

  exec.state = 'waiting';
  if (node.timeout !== undefined) {
    deps.assertActive();
    deps.scheduleTimeoutCheck(exec.id, exec.workflowName, idx, remaining);
  }
  deps.assertActive();
  deps.emitter?.emitWorkflow('workflow:waiting', exec.id, exec.workflowName, 'waiting');
  throw new WaitForSignalError(node.event);
}

/** The gate whose wait budget is spent. */
interface ExpiredGate {
  node: Extract<WorkflowNode, { type: 'waitFor' }>;
  idx: number;
  waitingSince: number;
  /** Overrides the timeout reason (a budget that cannot be measured). */
  reason?: string;
}

/**
 * Fail a gate whose budget is spent, unless its signal won the race.
 *
 * The signal check and the failing write are ONE claim (`expireWait`, see
 * storeWaitExpiry.ts), not a re-read followed by a write. The signaller may be another
 * connection that records the signal while this node runs; between a separate re-read
 * and the write it was accepted with `resumed: true` and its resume job published, and
 * then this run was failed and compensated anyway
 * (test/repro-workflow-signal-timeout-race.test.ts). Each outcome of the claim:
 *
 * - `expired`: the row is durably `failed`, so any later signal is rejected as
 *   "cannot receive the signal". Only now is the timeout a fact, so only now is
 *   `signal:timeout` emitted; emitting it first told listeners about a timeout the
 *   signal could still win, and a listener that signalled from inside the event was
 *   told the run resumed.
 * - `signalled`: nothing was written. Advance, exactly like a signal found on entry.
 *   If the signaller claimed the resume it also published a job for this node; that
 *   duplicate is dropped by admission (admission.ts), because this job holds the
 *   in-flight claim for the node until `advance` has already moved the cursor, after
 *   which the duplicate is `stale-cursor`. Standing down instead would be unsafe: a
 *   duplicate that arrives while the claim is held is discarded, and the run would
 *   then be advanced by nobody. When the signal was recorded on a `running` row
 *   (nobody claimed a resume), this advance is the only one there is. The in-flight
 *   claim is process-local, as it is for every duplicate node job (executor.ts).
 * - `moved`: another driver already advanced or finished this run. Neither fail nor
 *   advance it, the same stand-down as a lost park claim below.
 */
async function expireGate(
  deps: WaitForDeps,
  exec: Execution,
  wf: Workflow,
  gate: ExpiredGate
): Promise<void> {
  const { node, idx, waitingSince } = gate;
  const timeoutReason = gate.reason ?? `Signal "${node.event}" timed out after ${node.timeout}ms`;
  // Applied to a copy: on `signalled` the caller advances from `exec`, and a failure
  // left in it would be persisted by the very write that moves the cursor on.
  const failed: Execution = {
    ...exec,
    state: 'failed',
    failureReason: timeoutReason,
    steps: {
      ...exec.steps,
      [`__waitFor:${node.event}`]: {
        status: 'failed',
        startedAt: waitingSince,
        completedAt: clock().now(),
        error: timeoutReason,
      },
    },
  };
  // Persist failure before starting rollback. If force-close won, the fence throws
  // here, the durable row stays live, and replacement recovery re-evaluates the same
  // elapsed deadline through this same claim without the old executor compensating.
  deps.assertActive();
  const expiry = deps.store.expireWait(failed, node.event, idx);
  if (expiry.kind === 'moved') throw new WaitForSignalError(node.event);
  if (expiry.kind === 'signalled') {
    deps.assertActive();
    exec.signals = expiry.signals;
    await deps.advance(exec, idx + 1, wf);
    return;
  }

  exec.state = failed.state;
  exec.steps = failed.steps;
  exec.failureReason = failed.failureReason;
  exec.updatedAt = failed.updatedAt;
  deps.assertActive();
  deps.emitter?.emitSignal('signal:timeout', exec.id, exec.workflowName, node.event);
  // Compensate here, then signal completion via the WaitForSignalError sentinel so
  // processStep short-circuits (return null) instead of re-running compensation
  // through its generic catch path.
  deps.assertActive();
  await deps.compensate(exec, wf);
  deps.assertActive();
  deps.emitter?.emitWorkflow('workflow:failed', exec.id, exec.workflowName, 'failed');
  throw new WaitForSignalError(node.event);
}
