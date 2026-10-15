import { expect, test } from 'bun:test';
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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentJournal,
  AgentTurnError,
  AgentEffectUncertainError,
  agentEffectKey,
  runAgentEffect,
} from '../src/agents';
import { Engine, Workflow } from '../src/client/workflow';
import { shutdownManager } from '../src/client/manager';

setTracingDisabled(true);

function documentedFlow(AgentClass: unknown, ledger: unknown, agentJournal: AgentJournal) {
  const guide = readFileSync(
    new URL('../docs/src/content/docs/guide/workflow/agent-sdks.md', import.meta.url),
    'utf8'
  );
  const source = /```typescript\n([\s\S]*?)\n```/.exec(
    guide.split('## OpenAI Agents SDK')[1] ?? ''
  )?.[1];
  if (!source) throw new Error('Executable OpenAI effects example missing');
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    source.replace(/^import .*;\n/gm, '')
  );
  // oxlint-disable-next-line typescript/no-implied-eval -- execute the repository's trusted documented example
  return new Function(
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
    AgentClass,
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
}

test('documented OpenAI turn cannot succeed after an uncertain remote tool effect', async () => {
  shutdownManager();
  const directory = mkdtempSync(join(tmpdir(), 'bq-guide-uncertainty-'));
  const agentJournal = new AgentJournal(join(directory, 'agent.db'));
  let applied = 0;
  const ledger = {
    issue() {
      applied++;
      throw new Error('Response lost after refund commit');
    },
    reverse() {},
  };
  const model: Model = {
    async getResponse(request): Promise<ModelResponse> {
      const input = JSON.stringify(request.input);
      return {
        usage: new Usage(),
        output:
          input.includes('function_call_result') || input.includes('function_call_output')
            ? [
                {
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'Finished' }],
                },
              ]
            : [
                {
                  type: 'function_call',
                  id: 'fc_refund',
                  callId: 'call_refund',
                  name: 'issue_refund',
                  arguments: JSON.stringify({ orderId: 'ORDER-A', amount: 49 }),
                  status: 'completed',
                },
              ],
      } as ModelResponse;
    },
    // oxlint-disable-next-line require-yield -- the documented example uses non-streaming run()
    async *getStreamedResponse() {
      throw new Error('Unexpected streaming request');
    },
  };
  class DocumentedAgent extends Agent {
    constructor(options: ConstructorParameters<typeof Agent>[0]) {
      super({ ...options, model });
    }
  }
  const flow = documentedFlow(DocumentedAgent, ledger, agentJournal);
  const engine = new Engine({ embedded: true });
  try {
    engine.register(flow);
    const execution = await engine.start('refund-flow', { orderId: 'ORDER-A' });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && engine.getExecution(execution.id)?.state !== 'failed') {
      await Bun.sleep(25);
    }
    const current = engine.getExecution(execution.id);
    expect(current?.state).toBe('failed');
    expect(current?.steps['agent-turn'].result).toBeUndefined();
    expect(applied).toBe(1);
    expect(
      agentJournal.getEffect(
        { executionId: execution.id, stepId: 'agent-turn' },
        'refund:ORDER-A:49'
      )?.status
    ).toBe('pending');
  } finally {
    await engine.close(true);
    shutdownManager();
    agentJournal.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);

test('documented OpenAI tool propagation preserves the operator idempotency key and original cause', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bq-guide-operator-'));
  const agentJournal = new AgentJournal(join(directory, 'agent.db'));
  const cause = new Error('Remote response lost');
  let applied = 0;
  const model: Model = {
    async getResponse(request): Promise<ModelResponse> {
      return {
        usage: new Usage(),
        output: JSON.stringify(request.input).includes('function_call_result')
          ? [
              {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'Finished' }],
              },
            ]
          : [
              {
                type: 'function_call',
                id: 'fc_refund',
                callId: 'refund',
                name: 'issue_refund',
                arguments: JSON.stringify({ orderId: 'ORDER-A', amount: 49 }),
                status: 'completed',
              },
            ],
      } as ModelResponse;
    },
    // oxlint-disable-next-line require-yield -- the guide uses non-streaming run()
    async *getStreamedResponse() {
      throw new Error('Unexpected streaming request');
    },
  };
  class DocumentedAgent extends Agent {
    constructor(options: ConstructorParameters<typeof Agent>[0]) {
      super({ ...options, model });
    }
  }
  try {
    const flow = documentedFlow(
      DocumentedAgent,
      {
        issue() {
          applied++;
          throw cause;
        },
        reverse() {},
      },
      agentJournal
    );
    const node = flow.nodes[0];
    if (node?.type !== 'step') throw new Error('Expected an agent step');
    const error = await Promise.resolve(
      node.def.handler({
        input: { orderId: 'ORDER-A' },
        executionId: 'run',
        steps: {},
        signals: {},
      })
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AgentEffectUncertainError);
    expect((error as Error).cause).toBe(cause);
    expect((error as AgentEffectUncertainError).idempotencyKey).toBe(
      agentEffectKey({ executionId: 'run', stepId: 'agent-turn' }, 'refund:ORDER-A:49')
    );
    expect(applied).toBe(1);
    expect(
      agentJournal.getEffect({ executionId: 'run', stepId: 'agent-turn' }, 'refund:ORDER-A:49')
        ?.status
    ).toBe('pending');
  } finally {
    agentJournal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
