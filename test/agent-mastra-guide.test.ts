/* oxlint-disable typescript/no-implied-eval -- execute the repository's trusted guide with real SDK/helpers */
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { Engine, Workflow } from '../src/client/workflow';
import { shutdownManager } from '../src/client/manager';
import { AgentJournal, runAgentEffect, AgentTurnError } from '../src/agents';

test('documented Mastra effects remain owned by each concurrent handler', async () => {
  shutdownManager();
  let release!: () => void;
  const bothIssued = new Promise<void>((resolve) => {
    release = resolve;
  });
  class IssuedRefunds extends Array<string> {
    override push(...ids: string[]) {
      const length = super.push(...ids);
      if (length === 2) release();
      return length;
    }
  }
  const ledger = {
    issued: new IssuedRefunds(),
    issue(id: string) {
      ledger.issued.push(id);
      return id;
    },
    reverse(_id: string) {},
  };
  const model = new MockLanguageModelV3({
    doGenerate: async (request) => {
      if (request.prompt.some((message) => message.role === 'tool')) {
        await bothIssued;
        return {
          content: [{ type: 'text' as const, text: 'refund issued' }],
          finishReason: { type: 'stop' as const, raw: 'stop' },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      }
      return {
        content: [
          {
            type: 'tool-call' as const,
            toolCallId: 'call-1',
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
  const guide = readFileSync(
    new URL('../docs/src/content/docs/guide/workflow/agent-sdks.md', import.meta.url),
    'utf8'
  );
  const section = guide.split('## Mastra')[1]?.split('## LangGraph')[0];
  const source = /```typescript\n([\s\S]*?)\n```/.exec(section ?? '')?.[1];
  if (!source) throw new Error('Executable Mastra wrapper example missing');
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    source.replace(/^import .*;\n/gm, '')
  );
  const dir = mkdtempSync(join(tmpdir(), 'bq-agent-mastra-'));
  const agentJournal = new AgentJournal(join(dir, 'agent.db'));
  const engine = new Engine({ embedded: true, concurrency: 2 });
  try {
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
    engine.register(flow);
    const a = await engine.start('mastra-refund');
    const b = await engine.start('mastra-refund');
    const deadline = Date.now() + 20000;
    while (
      Date.now() < deadline &&
      [a.id, b.id].some((id) => engine.getExecution(id)?.state !== 'failed')
    )
      await Bun.sleep(25);
    expect(engine.getExecution(a.id)?.state).toBe('failed');
    expect(engine.getExecution(b.id)?.state).toBe('failed');
    expect(engine.getExecution(a.id)?.steps['agent-turn'].result).toMatchObject({
      effects: ['rf_ORD-9'],
    });
    expect(engine.getExecution(b.id)?.steps['agent-turn'].result).toMatchObject({
      effects: ['rf_ORD-9'],
    });
  } finally {
    release();
    await engine.close(true);
    shutdownManager();
    agentJournal.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
