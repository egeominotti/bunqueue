/* oxlint-disable typescript/no-implied-eval -- execute the repository's trusted wrapper, substituting only provider transport */
import { expect, test } from 'bun:test';
import type { query } from '@anthropic-ai/claude-agent-sdk';
import type { NonStreamRunOptions } from '@openai/agents';
import { readFileSync } from 'node:fs';
import { consumeAgentTurn, mapClaudeMessages } from '../src/agents';

// Compiled separately against the installed SDK declarations, without provider requests.
const claudeOptions = {
  abortController: new AbortController(),
  cwd: '/tmp',
  maxTurns: 6,
} satisfies NonNullable<Parameters<typeof query>[0]['options']>;
const openaiOptions = { signal: new AbortController().signal } satisfies NonStreamRunOptions;
void claudeOptions;
void openaiOptions;

test('live Claude wrapper rejects a failed provider terminal result and cancels through SDK options', async () => {
  const script = readFileSync(
    new URL('../scripts/agent-sdks/claude-agent-live.ts', import.meta.url),
    'utf8'
  );
  const source = script.slice(
    script.indexOf('async function agentTurn('),
    script.indexOf('async function settle(')
  );
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
  let controller: AbortController | undefined;
  const externalQuery = (args: Parameters<typeof query>[0]) => {
    controller = args.options?.abortController;
    async function* messages() {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        session_id: 'failed',
      };
    }
    return Object.assign(messages(), { close() {} });
  };
  const turn = new Function(
    'query',
    'consumeAgentTurn',
    'mapClaudeMessages',
    'MODEL',
    `${code}\nreturn agentTurn;`
  )(externalQuery, consumeAgentTurn, mapClaudeMessages, 'offline-model') as (
    prompt: string,
    cwd: string
  ) => Promise<unknown>;
  await expect(turn('task', '/tmp')).rejects.toMatchObject({ code: 'failure' });
  expect(controller).toBeInstanceOf(AbortController);
});
