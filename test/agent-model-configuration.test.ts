/* oxlint-disable typescript/no-implied-eval -- execute trusted documented/live wrappers without a provider */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { consumeAgentTurn, mapClaudeMessages } from '../src/agents';

for (const target of ['guide', 'live-script']) {
  test(`${target} leaves Claude model selection to the user's CLI configuration`, async () => {
    const source =
      target === 'guide'
        ? readFileSync(
            new URL('../docs/src/content/docs/guide/workflow/agent-sdks.md', import.meta.url),
            'utf8'
          )
        : readFileSync(
            new URL('../scripts/agent-sdks/claude-agent-live.ts', import.meta.url),
            'utf8'
          );
    const wrapper =
      target === 'guide'
        ? /```typescript\n([\s\S]*?)\n```/.exec(source.split('## Claude Agent SDK')[1] ?? '')?.[1]
        : source.slice(
            source.indexOf('async function agentTurn('),
            source.indexOf('async function settle(')
          );
    if (!wrapper) throw new Error('Actual Claude wrapper missing');
    const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(
      wrapper.replace(/^import .*;\n/gm, '')
    );
    let options: Record<string, unknown> = {};
    const query = (args: { options: Record<string, unknown> }) => {
      options = args.options;
      return Object.assign(
        (async function* () {
          yield { type: 'result', subtype: 'success', session_id: 'configured', result: 'ok' };
        })(),
        { close() {} }
      );
    };
    const turn = new Function(
      'query',
      'consumeAgentTurn',
      'mapClaudeMessages',
      'MODEL',
      `${code}\nreturn agentTurn;`
    )(query, consumeAgentTurn, mapClaudeMessages, 'imposed-default') as (
      prompt: string,
      cwd: string
    ) => Promise<unknown>;
    expect(await turn('offline task', '/tmp')).toMatchObject({ text: 'ok' });
    expect(Object.hasOwn(options, 'model')).toBe(false);
  });
}
