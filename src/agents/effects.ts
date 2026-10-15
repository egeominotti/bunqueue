import { createHash, randomUUID } from 'node:crypto';
import type { AgentJournal, EffectRecord } from './journal';
import { identity } from './progress';
import { AgentEffectUncertainError, type AgentRunIdentity } from './types';

export type EffectReconciliation<T> =
  | { status: 'completed'; result: T }
  | { status: 'not_applied' }
  | { status: 'unknown' };

export interface AgentEffectOptions<T> extends AgentRunIdentity {
  journal: AgentJournal;
  /** Stable business operation identity, e.g. refund:order-123 (never a new provider call ID). */
  callId: string;
  invoke: (idempotencyKey: string) => Promise<T>;
  /** Prove the original invocation stopped and its remote outcome before returning not_applied. */
  reconcile?: (idempotencyKey: string) => Promise<EffectReconciliation<T>>;
}

export function agentEffectKey(run: AgentRunIdentity, callId: string): string {
  const parts = [identity(run.executionId), identity(run.stepId), identity(callId)];
  return `bq-agent-${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}

function completed<T>(record: EffectRecord): T {
  if (record.result === null) throw new Error('Completed agent effect is missing its result');
  return (JSON.parse(record.result) as { value: T }).value;
}

function reconciliation<T>(value: unknown): EffectReconciliation<T> {
  if (
    !value ||
    typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error('Invalid agent effect reconciliation');
  }
  const status = Object.getOwnPropertyDescriptor(value, 'status');
  if (!status || !('value' in status) || !status.enumerable)
    throw new Error('Invalid reconciliation status');
  const keys = Reflect.ownKeys(value);
  if (status.value === 'completed') {
    const result = Object.getOwnPropertyDescriptor(value, 'result');
    if (keys.length !== 2 || !result || !('value' in result) || !result.enumerable) {
      throw new Error('Completed reconciliation requires an explicit result');
    }
    return { status: 'completed', result: result.value as T };
  }
  if (keys.length === 1 && (status.value === 'not_applied' || status.value === 'unknown')) {
    return { status: status.value };
  }
  throw new Error('Invalid agent effect reconciliation');
}

export async function runAgentEffect<T>(options: AgentEffectOptions<T>): Promise<T> {
  const { journal, callId, invoke, reconcile } = options;
  const key = agentEffectKey(options, callId);
  const token = randomUUID();
  const complete = (result: T) => {
    try {
      if (!journal.completeEffect(options, callId, token, result))
        throw new AgentEffectUncertainError(key);
    } catch (cause) {
      throw new AgentEffectUncertainError(key, { cause });
    }
    return result;
  };
  if (!journal.claimEffect(options, callId, token)) {
    const prior = journal.getEffect(options, callId);
    if (!prior) throw new AgentEffectUncertainError(key);
    if (prior.status === 'completed') return completed<T>(prior);
    if (!reconcile) throw new AgentEffectUncertainError(key);
    let outcome: EffectReconciliation<T>;
    try {
      outcome = reconciliation<T>(await reconcile(key));
    } catch (cause) {
      throw new AgentEffectUncertainError(key, { cause });
    }
    if (outcome.status === 'unknown') throw new AgentEffectUncertainError(key);
    if (!journal.replacePending(options, callId, prior.token, token)) {
      const current = journal.getEffect(options, callId);
      if (current?.status === 'completed') return completed<T>(current);
      throw new AgentEffectUncertainError(key);
    }
    if (outcome.status === 'completed') {
      return complete(outcome.result);
    }
  }
  // Any failure (including serialization/commit failure) deliberately leaves a pending outcome.
  let result: T;
  try {
    result = await invoke(key);
  } catch (cause) {
    throw new AgentEffectUncertainError(key, { cause });
  }
  return complete(result);
}
