/* oxlint-disable typescript/no-implied-eval -- execute the repository's trusted guide with the installed SDK */
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { Workflow } from '../src/client/workflow';
import {
  AgentJournal,
  AgentTurnError,
  AgentEffectUncertainError,
  agentEffectKey,
  runAgentEffect,
} from '../src/agents';

test('documented Mastra turn preserves original effect uncertainty when its SDK handles a tool error', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bq-mastra-uncertainty-'));
  const agentJournal = new AgentJournal(join(directory, 'journal.db'));
  const cause = new Error('Response lost after remote refund');
  let applied = 0;
  const ledger = {
    issue() {
      applied++;
      throw cause;
    },
    reverse() {},
  };
  const model = new MockLanguageModelV3({
    doGenerate: async (request) => {
      if (request.prompt.some((message) => message.role === 'tool')) {
        return {
          content: [{ type: 'text' as const, text: 'finished' }],
          finishReason: { type: 'stop' as const, raw: 'stop' },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      }
      return {
        content: [
          {
            type: 'tool-call' as const,
            toolCallId: 'refund',
            toolName: 'refundTool',
            input: JSON.stringify({ orderId: 'ORD-9', amount: 49 }),
          },
        ],
        finishReason: { type: 'tool-calls' as const, raw: 'tool_calls' },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
  });
  try {
    const guide = readFileSync(
      new URL('../docs/src/content/docs/guide/workflow/agent-sdks.md', import.meta.url),
      'utf8'
    );
    const source = /```typescript\n([\s\S]*?)\n```/.exec(guide.split('## Mastra')[1] ?? '')?.[1];
    if (!source) throw new Error('Mastra guide example missing');
    const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(
      source.replace(/^import .*;\n/gm, '')
    );
    const flow = new Function(
      'Agent',
      'createTool',
      'anthropic',
      'z',
      'Workflow',
      'ledger',
      'agentJournal',
      'runAgentEffect',
      'AgentTurnError',
      'configuredModel',
      `${code}\nreturn flow;`
    )(
      Agent,
      createTool,
      () => model,
      z,
      Workflow,
      ledger,
      agentJournal,
      runAgentEffect,
      AgentTurnError,
      'caller-cli-model'
    ) as Workflow;
    const node = flow.nodes[0];
    if (node?.type !== 'step') throw new Error('Expected an agent step');
    const error = await Promise.resolve(
      node.def.handler({ input: {}, steps: {}, signals: {}, executionId: 'run' })
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AgentEffectUncertainError);
    expect((error as Error).cause).toBe(cause);
    expect((error as AgentEffectUncertainError).idempotencyKey).toBe(
      agentEffectKey({ executionId: 'run', stepId: 'agent-turn' }, 'refund:ORD-9:49')
    );
    expect(applied).toBe(1);
    expect(
      agentJournal.getEffect({ executionId: 'run', stepId: 'agent-turn' }, 'refund:ORD-9:49')
        ?.status
    ).toBe('pending');
  } finally {
    agentJournal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
