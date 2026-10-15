/* oxlint-disable typescript/no-implied-eval -- execute the repository's trusted guide with real helpers */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentJournal,
  consumeAgentTurn,
  mapClaudeMessages,
  type AgentTurnOptions,
} from '../src/agents';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

/** Execute the guide's actual wrapper; only the external SDK message source is replaced. */
function documentedTurn(messages: unknown[], observe?: (controller: AbortController) => void) {
  const guide = readFileSync(
    new URL('../docs/src/content/docs/guide/workflow/agent-sdks.md', import.meta.url),
    'utf8'
  );
  const section = guide.split('## Claude Agent SDK')[1]?.split('## OpenAI Agents SDK')[0];
  const source = /```typescript\n([\s\S]*?)\n```/.exec(section ?? '')?.[1];
  if (!source) throw new Error('Executable Claude wrapper example missing');
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    source.replace(/^import .*;\n/gm, '')
  );
  async function* stream() {
    for (const message of messages) yield message;
  }
  return new Function(
    'query',
    'consumeAgentTurn',
    'mapClaudeMessages',
    `${code}\nreturn agentTurn;`
  )(
    (args: { options: { abortController: AbortController } }) => {
      observe?.(args.options.abortController);
      return Object.assign(stream(), { close() {} });
    },
    consumeAgentTurn,
    mapClaudeMessages
  ) as (prompt: string, cwd: string, options?: AgentTurnOptions<string>) => Promise<unknown>;
}

test('documented Claude wrapper propagates a non-success terminal outcome', async () => {
  const turn = documentedTurn([
    { type: 'system', subtype: 'init', session_id: 'session-failed' },
    {
      type: 'result',
      subtype: 'error_max_turns',
      session_id: 'session-failed',
      is_error: true,
      errors: ['Maximum turns reached'],
    },
  ]);
  await expect(turn('task', '/tmp')).rejects.toThrow();
});

test('documented wrapper forwards abort to the provider controller and checkpoints sessions durably', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bq-guide-session-'));
  const journal = new AgentJournal(join(dir, 'journal.db'));
  cleanup.push(() => {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const turn = documentedTurn([
    { type: 'system', subtype: 'init', session_id: 'checkpointed' },
    {
      type: 'result',
      subtype: 'success',
      session_id: 'checkpointed',
      result: 'done',
      is_error: false,
    },
  ]);
  expect(await turn('task', dir, { journal, executionId: 'run', stepId: 'turn' })).toEqual({
    sessionId: 'checkpointed',
    text: 'done',
  });
  expect(journal.getSession('run', 'turn')).toBe('checkpointed');
  const controller = new AbortController();
  let providerController: AbortController | undefined;
  const cancelled = documentedTurn([], (value) => {
    providerController = value;
  });
  const pending = cancelled('task', dir, { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  expect(providerController?.signal.aborted).toBe(true);
});

test('documented Claude wrapper rejects a stream without a final result', async () => {
  const turn = documentedTurn([
    { type: 'system', subtype: 'init', session_id: 'session-interrupted' },
  ]);
  await expect(turn('task', '/tmp')).rejects.toThrow();
});
