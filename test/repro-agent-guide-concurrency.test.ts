/* oxlint-disable typescript/no-implied-eval -- execute the repository's trusted guide with real SDK/helpers */
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Agent,
  run,
  tool,
  setTracingDisabled,
  type Model,
  type ModelResponse,
} from '@openai/agents';
import { Usage } from '@openai/agents-core';
import { z } from 'zod';
import { Engine, Workflow } from '../src/client/workflow';
import { shutdownManager } from '../src/client/manager';
import { AgentJournal, AgentTurnError, runAgentEffect } from '../src/agents';

setTracingDisabled(true);

test('documented OpenAI tool effects belong to their own concurrent workflow run', async () => {
  shutdownManager();
  let issued = 0;
  let release: () => void = () => {};
  const bothIssued = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ledger = {
    issue(id: string) {
      issued++;
      if (issued === 2) release();
      return id;
    },
    reverse(_id: string) {},
  };
  const model: Model = {
    async getResponse(request): Promise<ModelResponse> {
      const input = JSON.stringify(request.input);
      const orderId = /Refund order (ORDER-[AB])/.exec(input)?.[1];
      if (!orderId) throw new Error('Expected the run-specific order in model input');
      if (input.includes('function_call_result') || input.includes('function_call_output')) {
        await bothIssued;
        return {
          usage: new Usage(),
          output: [
            {
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'Refund issued' }],
            },
          ],
        } as ModelResponse;
      }
      return {
        usage: new Usage(),
        output: [
          {
            type: 'function_call',
            id: `fc_${orderId}`,
            callId: `call_${orderId}`,
            name: 'issue_refund',
            arguments: JSON.stringify({ orderId, amount: 49 }),
            status: 'completed',
          },
        ],
      } as ModelResponse;
    },
    // oxlint-disable-next-line require-yield -- this guide example uses non-streaming run()
    async *getStreamedResponse() {
      throw new Error('Unexpected streaming request');
    },
  };
  class DocumentedAgent extends Agent {
    constructor(options: ConstructorParameters<typeof Agent>[0]) {
      super({ ...options, model });
    }
  }
  const guide = readFileSync(
    new URL('../docs/src/content/docs/guide/workflow/agent-sdks.md', import.meta.url),
    'utf8'
  );
  const section = guide.split('## OpenAI Agents SDK')[1];
  const source = /```typescript\n([\s\S]*?)\n```/.exec(section ?? '')?.[1];
  if (!source) throw new Error('Executable OpenAI effects example missing');
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    source.replace(/^import .*;\n/gm, '')
  );
  const dir = mkdtempSync(join(tmpdir(), 'bq-agent-guide-'));
  const agentJournal = new AgentJournal(join(dir, 'agent.db'));
  const flow = new Function(
    'Agent',
    'run',
    'tool',
    'z',
    'Workflow',
    'ledger',
    'agentJournal',
    'AgentTurnError',
    'runAgentEffect',
    'configuredModel',
    `${code}\nreturn flow;`
  )(
    DocumentedAgent,
    run,
    tool,
    z,
    Workflow,
    ledger,
    agentJournal,
    AgentTurnError,
    runAgentEffect,
    'caller-cli-model'
  ) as Workflow<{ orderId: string }>;
  const engine = new Engine({ embedded: true, concurrency: 2 });
  try {
    engine.register(flow);
    const a = await engine.start('refund-flow', { orderId: 'ORDER-A' });
    const b = await engine.start('refund-flow', { orderId: 'ORDER-B' });
    const deadline = Date.now() + 20000;
    while (
      Date.now() < deadline &&
      [a.id, b.id].some((id) => engine.getExecution(id)?.state !== 'failed')
    ) {
      await Bun.sleep(25);
    }
    expect(engine.getExecution(a.id)?.state).toBe('failed');
    expect(engine.getExecution(b.id)?.state).toBe('failed');
    expect(engine.getExecution(a.id)?.steps['agent-turn'].result).toMatchObject({
      effects: [{ refundId: 'rf_ORDER-A' }],
    });
    expect(engine.getExecution(b.id)?.steps['agent-turn'].result).toMatchObject({
      effects: [{ refundId: 'rf_ORDER-B' }],
    });
  } finally {
    release();
    await engine.close(true);
    shutdownManager();
    agentJournal.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
