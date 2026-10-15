/* oxlint-disable typescript/no-implied-eval -- execute the repository's trusted supplementary examples with the installed SDK */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
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
import { Workflow } from '../src/client/workflow';
import { AgentTurnError } from '../src/agents';

setTracingDisabled(true);

function supplementaryHandler(section: string, index: number, agent: Agent) {
  const guide = readFileSync(
    new URL('../docs/src/content/docs/guide/workflow/agent-sdks.md', import.meta.url),
    'utf8'
  );
  const source = /```typescript\n([\s\S]*?)\n```/.exec(guide.split(section)[1] ?? '')?.[1];
  if (!source) throw new Error('Supplementary guide example missing');
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    source.replace(/^import .*;\n/gm, '')
  );
  const flow = new Function(
    'Workflow',
    'agent',
    'run',
    'z',
    'AgentTurnError',
    'store',
    `${code}\nreturn flow;`
  )(Workflow, agent, run, z, AgentTurnError, { deleted: [], restored: [] }) as Workflow;
  const node = flow.nodes[index];
  if (node?.type !== 'step') throw new Error('Expected an executable step');
  return node.def.handler;
}

const examples = [
  {
    name: 'first history turn',
    section: '### The transcript survives the step boundary',
    index: 0,
  },
  {
    name: 'second history turn',
    section: '### The transcript survives the step boundary',
    index: 1,
  },
  { name: 'approval turn', section: '### Approval gates work the same way', index: 0 },
];
for (const example of examples) {
  test(`documented ${example.name} forwards its existing workflow cancellation signal`, async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const model: Model = {
      async getResponse(request): Promise<ModelResponse> {
        observed = request.signal;
        return {
          usage: new Usage(),
          output: [
            {
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'finished' }],
            },
          ],
        } as ModelResponse;
      },
      // oxlint-disable-next-line require-yield -- the examples call non-streaming run()
      async *getStreamedResponse() {
        throw new Error('Unexpected streaming request');
      },
    };
    const handler = supplementaryHandler(
      example.section,
      example.index,
      new Agent({ name: 'offline', model })
    );
    await handler({
      input: {},
      steps: { 'turn-1': { history: [] } },
      signals: {},
      executionId: 'run',
      signal: controller.signal,
    });
    expect(observed).toBe(controller.signal);
  });

  test(`documented ${example.name} refuses an SDK approval interruption as terminal success`, async () => {
    const model: Model = {
      async getResponse(): Promise<ModelResponse> {
        return {
          usage: new Usage(),
          output: [
            {
              type: 'function_call',
              id: 'fc_approval',
              callId: 'approval',
              name: 'dangerous_operation',
              arguments: '{}',
              status: 'completed',
            },
          ],
        } as ModelResponse;
      },
      // oxlint-disable-next-line require-yield -- the examples call non-streaming run()
      async *getStreamedResponse() {
        throw new Error('Unexpected streaming request');
      },
    };
    const agent = new Agent({
      name: 'offline',
      model,
      tools: [
        tool({
          name: 'dangerous_operation',
          description: 'Requires approval',
          parameters: z.object({}),
          needsApproval: true,
          execute: async () => 'approved',
        }),
      ],
    });
    const handler = supplementaryHandler(example.section, example.index, agent);
    await expect(
      Promise.resolve(
        handler({
          input: {},
          steps: { 'turn-1': { history: [] } },
          signals: {},
          executionId: 'run',
        })
      )
    ).rejects.toMatchObject({ code: 'needs_input' });
  });
}
