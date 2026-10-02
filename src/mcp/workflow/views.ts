/**
 * JSON views of workflow executions for the MCP tools.
 *
 * The MCP server has no workflow definitions, so a node is reported by its index;
 * step records are keyed by the names the application gave them.
 */

import { hasSignal } from '../../client/workflow/storeSignals';
import type { Execution, StepRecord } from '../../client/workflow/types';
import { isoTime, toJsonSafe } from './jsonSafe';

/** Bookkeeping record a waitFor gate with a timeout writes when the run parks. */
const WAIT_RECORD_PREFIX = '__waitFor:';

/**
 * The event a parked run is waiting for, when the store records it.
 *
 * Only a waitFor with a timeout writes a `__waitFor:<event>` record, and a gate the
 * run already passed keeps its record but has its signal, so the open gate is the one
 * running record whose signal is absent. Null for an untimed gate or a run that is
 * not waiting.
 */
export function awaitedEvent(exec: Execution): string | null {
  if (exec.state !== 'waiting') return null;
  const open = Object.entries(exec.steps)
    .filter(([key, record]) => key.startsWith(WAIT_RECORD_PREFIX) && record.status === 'running')
    .map(([key]) => key.slice(WAIT_RECORD_PREFIX.length))
    .filter((event) => !hasSignal(exec.signals, event));
  return open.length === 1 ? open[0] : null;
}

function base(exec: Execution) {
  return {
    id: exec.id,
    workflowName: exec.workflowName,
    state: exec.state,
    currentNodeIndex: exec.currentNodeIndex,
    ...(exec.state === 'waiting' ? { waitingFor: awaitedEvent(exec) } : {}),
    failureReason: exec.failureReason,
    rollbackStatus: exec.rollbackStatus,
    parentExecutionId: exec.parentExecutionId,
    createdAt: isoTime(exec.createdAt),
    updatedAt: isoTime(exec.updatedAt),
  };
}

/** Compact row for listings: no input, step results or payloads. */
export function executionSummary(exec: Execution): unknown {
  return toJsonSafe({ ...base(exec), signalEvents: Object.keys(exec.signals) });
}

function stepView(name: string, record: StepRecord) {
  return {
    name,
    status: record.status,
    attempts: record.attempts,
    error: record.error,
    startedAt: isoTime(record.startedAt),
    completedAt: isoTime(record.completedAt),
    result: record.result,
    compensatable: record.compensatable,
    compensation: record.compensation
      ? {
          status: record.compensation.status,
          at: isoTime(record.compensation.at),
          error: record.compensation.error,
        }
      : undefined,
    loopIndex: record.loopIndex,
    loopItem: record.loopItem,
    childExecutionId: record.childExecutionId,
    occurrence: record.occurrence,
  };
}

/** Everything the store knows about one execution, JSON-safe. */
export function executionDetail(exec: Execution): unknown {
  return toJsonSafe({
    ...base(exec),
    input: exec.input,
    steps: Object.entries(exec.steps).map(([name, record]) => stepView(name, record)),
    // A signal sent without a payload is stored as `undefined`; keep it visible.
    signals: Object.entries(exec.signals).map(([event, payload]) => ({
      event,
      payload: payload === undefined ? null : payload,
    })),
    resolvedSteps: exec.resolvedSteps,
    decisions: exec.decisions,
    committedAt: exec.committedAt,
    definitionHash: exec.definitionHash,
  });
}
