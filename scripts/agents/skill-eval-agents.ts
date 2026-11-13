import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export type Json = Record<string, unknown>;
export type Env = Record<string, string>;
export interface AgentSpec {
  discovery: { args?: string[]; env?: Env; stopAt?: RegExp; names: (stdout: string) => string[] };
  session: (query: string) => string[];
  env?: Env;
  loaded: (event: Json) => string[];
  read?: (event: Json) => string[];
  finished: (event: Json) => boolean;
}
export const rec = (value: unknown): Json =>
  value && typeof value === 'object' ? (value as Json) : {};
export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const events = (out: string): Json[] =>
  out.split('\n').flatMap((line) => {
    try {
      return line.startsWith('{') ? [rec(JSON.parse(line))] : [];
    } catch {
      return [];
    }
  });
const flags = (text: string): string[] => text.split(' ');

/** Decode shell words without evaluating expansions or executing logged commands. */
function shellWords(text: string): string[] {
  const words: string[] = [];
  let word = '',
    quote = '',
    active = false,
    expansion = false;
  const finish = () => {
    if (active && !quote && !expansion) words.push(word);
    word = '';
    active = false;
    expansion = false;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote === "'") {
      if (char === "'") quote = '';
      else word += char;
    } else if (char === '\\' && quote !== "'") {
      const next = text[index + 1];
      if (next !== undefined && (!quote || /["$`\\\n]/.test(next))) {
        if (next !== '\n') word += next;
        index++;
      } else word += char;
      active = true;
    } else if (quote === '"') {
      if (char === '"') quote = '';
      else {
        word += char;
        if (char === '$' || char === '`') expansion = true;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      active = true;
    } else if (/[\s;|&()<>]/.test(char)) finish();
    else {
      word += char;
      active = true;
      if (char === '$' || char === '`') expansion = true;
    }
  }
  finish();
  return words;
}

export function agentSpecs(root: string, maxTurns: number): Record<string, AgentSpec> {
  const canonical = realpathSync(root);
  // Basenames cannot identify a skill: resolve actual files in this checkout.
  const skillPaths = (paths: string[]): string[] => {
    return paths.flatMap((candidate) => {
      try {
        const path = realpathSync(resolve(root, candidate));
        const relative = path.slice(canonical.length + 1);
        const name = /^\.agents\/skills\/([a-z0-9-]+)\/SKILL\.md$/.exec(relative)?.[1];
        return path.startsWith(`${canonical}/`) && name ? [name] : [];
      } catch {
        return [];
      }
    });
  };
  const discoveryPaths = (text: string): string[] =>
    skillPaths(
      [
        ...text.matchAll(
          /(?:^|[\s"'(])((?:\/|\.\.?\/|\.agents\/)[^\n]*?\/SKILL\.md)(?=$|[\s"')\]])/g
        ),
      ].map((match) => match[1]!)
    );
  const commandPaths = (text: unknown): string[] => {
    const words = shellWords(String(text ?? ''));
    // A shell launcher may wrap the actual command in its -c/-lc argument.
    const nested = words.flatMap((word, index) =>
      /^-[a-z]*c[a-z]*$/.test(words[index - 1] ?? '') ? shellWords(word) : []
    );
    return skillPaths([...words, ...nested].filter((word) => word.endsWith('/SKILL.md')));
  };
  const claudeTool = (event: Json, tool: string): Json[] =>
    list(rec(event.message).content)
      .map(rec)
      .filter((use) => event.type === 'assistant' && use.type === 'tool_use' && use.name === tool)
      .map((use) => rec(use.input));
  return {
    claude: {
      discovery: {
        stopAt: /"subtype":"init".*\n/,
        names: (out) => events(out).flatMap((event) => list(event.skills).map(String)),
      },
      session: (query) => [
        '-p',
        query,
        ...flags('--output-format stream-json --verbose --permission-mode plan'),
        ...flags(`--max-turns ${maxTurns} --permission-prompts none --strict-mcp-config`),
        ...flags('--tools Skill,Read,Grep,Glob --setting-sources project --no-session-persistence'),
      ],
      env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
      loaded: (event) => claudeTool(event, 'Skill').map((input) => String(input.skill)),
      read: (event) =>
        claudeTool(event, 'Read').flatMap((input) => skillPaths([String(input.file_path)])),
      finished: (event) =>
        event.type === 'result' && ['success', 'error_max_turns'].includes(String(event.subtype)),
    },
    codex: {
      discovery: { args: ['debug', 'prompt-input', 'x'], names: discoveryPaths },
      session: (query) => [
        ...flags('exec --json --sandbox read-only --ephemeral --ignore-user-config -c'),
        'approval_policy="never"',
        query,
      ],
      loaded: (event) => {
        const item = rec(event.item);
        return event.type === 'item.completed' &&
          item.type === 'command_execution' &&
          item.status === 'completed' &&
          item.exit_code === 0
          ? commandPaths(item.command)
          : [];
      },
      finished: (event) => event.type === 'turn.completed',
    },
    gemini: {
      discovery: {
        args: ['skills', 'list'],
        env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' },
        names: (out) => [...out.matchAll(/^(\S+) \[Enabled\]/gm)].map((match) => match[1]!),
      },
      session: (query) => [
        '-p',
        query,
        ...flags('-o stream-json --approval-mode plan --skip-trust'),
      ],
      loaded: (event) =>
        event.tool_name === 'activate_skill' ? [String(rec(event.parameters).name)] : [],
      finished: (event) => event.type === 'result' && event.status !== 'error',
    },
  };
}
