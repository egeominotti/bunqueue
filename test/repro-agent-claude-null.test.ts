import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AgentJournal, consumeAgentTurn, mapClaudeMessages } from '../src/agents';

test('Claude adapter preserves explicit structured null through output validation and journaling', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bq-claude-null-'));
  const journal = new AgentJournal(join(directory, 'agent.db'));
  async function* messages() {
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'session-null',
      structured_output: null,
      result: 'Fallback text is not the structured output',
    };
  }
  try {
    const result = await consumeAgentTurn(mapClaudeMessages(messages()), {
      schema: z.null(),
      journal,
      executionId: 'run-null',
      stepId: 'turn',
    });
    expect(result).toEqual({ sessionId: 'session-null', output: null });
    expect(journal.getSession('run-null', 'turn')).toBe('session-null');
    expect(journal.replay('run-null').events.map((record) => record.event.type)).toEqual([
      'session',
      'success',
    ]);
  } finally {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// Offline fixtures exercise the SDK's optional unknown-shaped structured output contract.
test.each([null, false, 0, ''])(
  'Claude adapter returns explicit structured %p without a schema',
  async (output) => {
    async function* messages() {
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'session-structured',
        structured_output: output,
        result: 'Fallback text is not the structured output',
      };
    }
    expect(await consumeAgentTurn(mapClaudeMessages(messages()), {})).toEqual({
      sessionId: 'session-structured',
      output,
    });
  }
);

test.each(['absent', 'undefined'] as const)(
  'Claude adapter falls back to text for %s structured output',
  async (kind) => {
    async function* messages() {
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'session-text',
        ...(kind === 'undefined' ? { structured_output: undefined } : {}),
        result: 'Legacy text output',
      };
    }
    expect(await consumeAgentTurn(mapClaudeMessages(messages()), { schema: z.string() })).toEqual({
      sessionId: 'session-text',
      output: 'Legacy text output',
    });
  }
);
