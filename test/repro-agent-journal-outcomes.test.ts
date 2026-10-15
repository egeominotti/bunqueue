import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentJournal,
  runAgentEffect,
  AgentEffectUncertainError,
  consumeAgentTurn,
  AgentTurnError,
} from '../src/agents';

const directories: string[] = [];
const journals: AgentJournal[] = [];
function journal(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'bq-agent-outcome-'));
  directories.push(directory);
  const value = new AgentJournal(join(directory, 'journal.db'), options);
  journals.push(value);
  return value;
}
afterEach(() => {
  for (const value of journals.splice(0)) value.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test('sparse array with a named effect result refuses lossy completion and stays uncertain', async () => {
  const store = journal();
  const identity = { journal: store, executionId: 'run', stepId: 'turn', callId: 'refund' };
  const value = new Array(1) as unknown[] & { refundId: string };
  value.refundId = 'refund-important';
  let calls = 0;
  await expect(
    runAgentEffect({
      ...identity,
      invoke: async () => {
        calls++;
        return value;
      },
    })
  ).rejects.toBeInstanceOf(AgentEffectUncertainError);
  expect(store.getEffect(identity, identity.callId)?.status).toBe('pending');
  await expect(
    runAgentEffect({
      ...identity,
      invoke: async () => {
        calls++;
        return value;
      },
    })
  ).rejects.toBeInstanceOf(AgentEffectUncertainError);
  expect(calls).toBe(1);
});

test('malformed reconciliation status cannot authorize repeating a pending remote effect', async () => {
  const store = journal();
  const identity = { journal: store, executionId: 'run', stepId: 'turn', callId: 'refund' };
  let calls = 0;
  await expect(
    runAgentEffect({
      ...identity,
      invoke: async () => {
        calls++;
        throw new Error('Remote response lost after issuing refund');
      },
    })
  ).rejects.toBeInstanceOf(AgentEffectUncertainError);
  await expect(
    runAgentEffect({
      ...identity,
      invoke: async () => {
        calls++;
        return 'duplicate-refund';
      },
      reconcile: async () => ({ status: 'provider_unavailable' }) as never,
    })
  ).rejects.toBeInstanceOf(AgentEffectUncertainError);
  expect(calls).toBe(1);
  expect(store.getEffect(identity, identity.callId)?.status).toBe('pending');
});

test('reconciliation lookup failure retains typed uncertainty and original cause', async () => {
  const store = journal();
  const identity = { journal: store, executionId: 'run', stepId: 'turn', callId: 'refund' };
  await expect(
    runAgentEffect({
      ...identity,
      invoke: async () => {
        throw new Error('Remote response lost');
      },
    })
  ).rejects.toBeInstanceOf(AgentEffectUncertainError);
  const cause = new Error('Ledger lookup unavailable');
  let calls = 0;
  const error = await runAgentEffect({
    ...identity,
    invoke: async () => {
      calls++;
      return 'duplicate-refund';
    },
    reconcile: async () => {
      throw cause;
    },
  }).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(AgentEffectUncertainError);
  expect((error as Error).cause).toBe(cause);
  expect(calls).toBe(0);
  expect(store.getEffect(identity, identity.callId)?.status).toBe('pending');
});

test('failure recording cannot mask a typed invalid agent output', async () => {
  const store = journal({ maxEventBytes: 20 });
  const cause = new Error('Output violates schema');
  async function* source() {
    yield { type: 'success' as const, output: 'invalid' };
  }
  const error = await consumeAgentTurn(source(), {
    journal: store,
    executionId: 'run',
    stepId: 'turn',
    schema: {
      parse() {
        throw cause;
      },
    },
  }).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(AgentTurnError);
  expect((error as AgentTurnError).code).toBe('invalid_output');
  expect((error as Error).cause).toBe(cause);
  expect((error as AgentTurnError).recordingError).toBeInstanceOf(Error);
  expect(store.replay('run').events.some((record) => record.event.type === 'success')).toBe(false);
});

test('malformed reconciliation shapes retain the prior pending token and stable uncertainty key', async () => {
  const store = journal();
  const shapes = [
    null,
    undefined,
    { status: 'completed' },
    { status: 'not_applied', extra: true },
    { status: 'unknown', result: 'unproven' },
    { status: 'not_applied', result: 'unproven' },
  ];
  for (let index = 0; index < shapes.length; index++) {
    const identity = {
      journal: store,
      executionId: 'run',
      stepId: 'turn',
      callId: `refund:${index}`,
    };
    const priorError = await runAgentEffect({
      ...identity,
      invoke: async () => {
        throw new Error('Lost');
      },
    }).catch((error: unknown) => error);
    const token = store.getEffect(identity, identity.callId)?.token;
    let calls = 0;
    const error = await runAgentEffect({
      ...identity,
      invoke: async () => {
        calls++;
        return 'duplicate';
      },
      reconcile: async () => shapes[index] as never,
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AgentEffectUncertainError);
    expect((error as AgentEffectUncertainError).idempotencyKey).toBe(
      (priorError as AgentEffectUncertainError).idempotencyKey
    );
    expect(store.getEffect(identity, identity.callId)).toMatchObject({ status: 'pending', token });
    expect(calls).toBe(0);
  }
});

test('array prototype serialization overrides cannot alter a completed replay', async () => {
  const store = journal();
  class LossyArray extends Array<string> {
    toJSON() {
      return 'lost-effect';
    }
  }
  await expect(
    runAgentEffect({
      journal: store,
      executionId: 'run',
      stepId: 'turn',
      callId: 'refund:array',
      invoke: async () => new LossyArray('refund-important'),
    })
  ).rejects.toBeInstanceOf(AgentEffectUncertainError);
});

test('abort preserves cancelled classification when the real journal has already closed', async () => {
  const store = journal();
  store.close();
  const controller = new AbortController();
  const source = {
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<never>>(() => {}) };
    },
  };
  const pending = consumeAgentTurn(source, {
    journal: store,
    executionId: 'run',
    stepId: 'turn',
    signal: controller.signal,
  });
  controller.abort();
  const error = await pending.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AgentTurnError);
  expect((error as AgentTurnError).code).toBe('cancelled');
  expect((error as AgentTurnError & { recordingError: unknown }).recordingError).toBeInstanceOf(
    Error
  );
});

test('provider terminal failure codes survive progress persistence failure', async () => {
  const store = journal({ maxEventBytes: 1 });
  for (const type of ['failure', 'cancelled', 'needs_input'] as const) {
    async function* source() {
      yield { type };
    }
    const error = await consumeAgentTurn(source(), {
      journal: store,
      executionId: 'run',
      stepId: 'turn',
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AgentTurnError);
    expect((error as AgentTurnError).code).toBe(type);
    expect((error as AgentTurnError).recordingError).toBeInstanceOf(Error);
  }
});

test('an explicit undefined reconciled result completes a void effect without another invocation', async () => {
  const store = journal();
  const identity = { journal: store, executionId: 'run', stepId: 'turn', callId: 'void-operation' };
  await expect(
    runAgentEffect({
      ...identity,
      invoke: async () => {
        throw new Error('Lost response');
      },
    })
  ).rejects.toBeInstanceOf(AgentEffectUncertainError);
  let calls = 0;
  const invoke = async () => {
    calls++;
  };
  expect(
    await runAgentEffect({
      ...identity,
      invoke,
      reconcile: async () => ({ status: 'completed', result: undefined }),
    })
  ).toBeUndefined();
  expect(store.getEffect(identity, identity.callId)?.status).toBe('completed');
  expect(await runAgentEffect({ ...identity, invoke })).toBeUndefined();
  expect(calls).toBe(0);
});
