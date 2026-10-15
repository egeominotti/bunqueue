import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentJournal,
  AgentTurnError,
  consumeAgentTurn,
  mapClaudeMessages,
  type AgentEvent,
} from '../src/agents';

const dirs: string[] = [];
const journals: AgentJournal[] = [];
function journal() {
  const dir = mkdtempSync(join(tmpdir(), 'bq-agent-turn-'));
  dirs.push(dir);
  const value = new AgentJournal(join(dir, 'journal.db'));
  journals.push(value);
  return value;
}
afterEach(() => {
  for (const value of journals.splice(0)) value.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function* events(...values: AgentEvent[]) {
  yield* values;
}

test('session is durable before the source consumes its next event and output is parsed', async () => {
  const store = journal();
  async function* stream(): AsyncGenerator<AgentEvent> {
    yield { type: 'session', sessionId: 'session-1' };
    expect(store.getSession('run', 'turn')).toBe('session-1');
    yield { type: 'success', output: '42' };
  }
  const result = await consumeAgentTurn(stream(), {
    journal: store,
    executionId: 'run',
    stepId: 'turn',
    schema: { parse: (value) => Number(value) },
  });
  expect(result).toEqual({ sessionId: 'session-1', output: 42 });
});

test('non-success outcomes and missing terminal messages reject with typed failures', async () => {
  for (const type of ['failure', 'cancelled', 'needs_input'] as const) {
    await expect(consumeAgentTurn(events({ type }), {})).rejects.toBeInstanceOf(AgentTurnError);
  }
  await expect(
    consumeAgentTurn(events({ type: 'progress', message: 'working' }), {})
  ).rejects.toMatchObject({ code: 'interrupted' });
});

test('output validation failure is typed and does not journal a successful terminal event', async () => {
  const store = journal();
  await expect(
    consumeAgentTurn(events({ type: 'success', output: 'bad' }), {
      journal: store,
      executionId: 'run',
      stepId: 'turn',
      schema: {
        parse() {
          throw new Error('invalid output');
        },
      },
    })
  ).rejects.toMatchObject({ code: 'invalid_output' });
  expect(store.replay('run').events.map((event) => event.event.type)).toEqual(['failure']);
});

test('abort interrupts a blocked iterator, forwards cancellation and never returns late success', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const source: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<AgentEvent>>(() => {}) };
    },
  };
  const pending = consumeAgentTurn(source, {
    signal: controller.signal,
    cancel: () => {
      cancelled = true;
    },
  });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  expect(cancelled).toBe(true);
});

test('Claude adapter maps session and every result subtype and excludes provider prompt payloads', async () => {
  async function* messages() {
    yield { type: 'system', subtype: 'init', session_id: 'claude-session', prompt: 'SECRET' };
    yield {
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      errors: ['budget exhausted'],
      session_id: 'claude-session',
    };
  }
  const mapped = [];
  for await (const event of mapClaudeMessages(messages())) mapped.push(event);
  expect(mapped).toEqual([
    { type: 'session', sessionId: 'claude-session' },
    { type: 'session', sessionId: 'claude-session' },
    { type: 'failure', code: 'error_max_turns' },
  ]);
  await expect(consumeAgentTurn(mapClaudeMessages(messages()), {})).rejects.toMatchObject({
    code: 'failure',
  });
});
