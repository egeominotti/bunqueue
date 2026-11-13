/**
 * Shared helpers for the Agent Skills contract (`test/agent-skills.test.ts` and
 * `test/agent-skills-scripts.test.ts`, run with `bun test test/agent-skills`). The
 * skills and their rules are described in docs/agents/README.md#skills.
 */

import { chmodSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, read } from './agent-harness-support';

export const SKILLS_DIR = '.agents/skills';
export const CLAUDE_SKILLS_DIR = '.claude/skills';
/** The portable frontmatter keys (agentskills.io); anything else is client-specific. */
export const FRONTMATTER_KEYS = ['name', 'description', 'license', 'metadata'];
/** The top-level entries a skill directory may hold. */
export const SKILL_ENTRIES = ['SKILL.md', 'references', 'scripts', 'assets', 'evals', 'agents'];
/** Directories whose files SKILL.md must link (one level of progressive disclosure). */
export const BUNDLED_DIRS = ['references', 'scripts', 'assets'];

export function skillNames(): string[] {
  return readdirSync(join(ROOT, SKILLS_DIR), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Every file of one skill, repository-relative and sorted (symlinks are not followed). */
export function skillFiles(name: string): string[] {
  const base = `${SKILLS_DIR}/${name}`;
  return [...new Bun.Glob('**/*').scanSync({ cwd: join(ROOT, base), dot: true })]
    .map((path) => `${base}/${path}`)
    .sort();
}

export interface Skill {
  dir: string;
  /** The raw frontmatter text between the `---` lines. */
  raw: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseSkill(name: string): Skill {
  const dir = `${SKILLS_DIR}/${name}`;
  const text = read(`${dir}/SKILL.md`);
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error(`${dir}/SKILL.md: no YAML frontmatter between --- lines`);
  const parsed: unknown = Bun.YAML.parse(match[1]!);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${dir}/SKILL.md: the frontmatter is not a mapping`);
  }
  return {
    dir,
    raw: match[1]!,
    frontmatter: parsed as Record<string, unknown>,
    body: text.slice(match[0].length),
  };
}

/** The agentskills.io name rules, plus: the name is its directory's name. */
export function nameProblems(name: unknown, dir: string): string[] {
  if (typeof name !== 'string') return ['name is not a string'];
  const problems: string[] = [];
  if (name.length < 1 || name.length > 64) problems.push(`name has ${name.length} characters`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    problems.push(`name ${name}: only a-z, 0-9 and single inner hyphens`);
  }
  if (/anthropic|claude/.test(name)) problems.push(`name ${name} contains a reserved word`);
  if (name !== dir) problems.push(`name ${name} differs from its directory ${dir}`);
  return problems;
}

/** The description is one quoted line: block scalars (`>-`, `|`) parse differently across clients. */
export function descriptionLineProblems(raw: string): string[] {
  const lines = raw.split('\n').filter((line) => line.startsWith('description:'));
  if (lines.length !== 1) return [`${lines.length} description lines`];
  return /^description: (?:"[^"\\]*"|'(?:[^']|'')*')$/.test(lines[0]!)
    ? []
    : ['description is not a single quoted line'];
}

export function descriptionProblems(description: unknown): string[] {
  if (typeof description !== 'string') return ['description is not a string'];
  const text = description.trim();
  const problems: string[] = [];
  if (!text) problems.push('description is empty');
  if (text.length > 1024) problems.push(`description has ${text.length} characters (max 1024)`);
  if (/[<>]/.test(text)) problems.push('description contains < or >');
  if (!/\bUse (?:only )?when\b/.test(text)) problems.push('description has no "Use when" clause');
  return problems;
}

export function frontmatterProblems(frontmatter: Record<string, unknown>): string[] {
  const problems = Object.keys(frontmatter)
    .filter((key) => !FRONTMATTER_KEYS.includes(key))
    .map((key) => `non-portable frontmatter key: ${key}`);
  if ('license' in frontmatter && typeof frontmatter.license !== 'string') {
    problems.push('license is not a string');
  }
  if ('metadata' in frontmatter) {
    const metadata = frontmatter.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      problems.push('metadata is not a mapping');
    } else {
      for (const [key, value] of Object.entries(metadata)) {
        if (typeof value !== 'string') problems.push(`metadata.${key} is not a string`);
      }
    }
  }
  return problems;
}

interface TriggerQuery {
  query?: unknown;
  should_trigger?: unknown;
  note?: unknown;
}
interface EvalCase {
  id?: unknown;
  prompt?: unknown;
  expected_output?: unknown;
  assertions?: unknown;
  files?: unknown;
}

const isText = (value: unknown): value is string => typeof value === 'string' && !!value.trim();

/** The evals/evals.json shape documented in docs/agents/README.md#skills. */
export function evalsProblems(name: string, raw: string): string[] {
  const data = JSON.parse(raw) as {
    skill_name?: unknown;
    trigger_queries?: TriggerQuery[];
    evals?: EvalCase[];
  };
  const problems: string[] = [];
  if (data.skill_name !== name) problems.push(`skill_name ${String(data.skill_name)}`);
  const queries = Array.isArray(data.trigger_queries) ? data.trigger_queries : [];
  const seen = new Set<string>();
  for (const entry of queries) {
    if (!isText(entry.query)) problems.push('a trigger query has no query text');
    else if (seen.has(entry.query)) problems.push(`duplicate trigger query: ${entry.query}`);
    else seen.add(entry.query);
    if (typeof entry.should_trigger !== 'boolean') problems.push('should_trigger is not boolean');
    if (entry.note !== undefined && typeof entry.note !== 'string') problems.push('bad note');
  }
  const positive = queries.filter((entry) => entry.should_trigger === true).length;
  const negative = queries.filter((entry) => entry.should_trigger === false).length;
  if (positive < 8) problems.push(`${positive} should-trigger queries (at least 8)`);
  if (negative < 8) problems.push(`${negative} should-not-trigger queries (at least 8)`);
  const cases = Array.isArray(data.evals) ? data.evals : [];
  if (cases.length < 3) problems.push(`${cases.length} output scenarios (at least 3)`);
  const ids = new Set<unknown>();
  for (const entry of cases) {
    if (!Number.isInteger(entry.id) || (entry.id as number) < 1 || ids.has(entry.id)) {
      problems.push(`eval id ${String(entry.id)} is not a unique positive integer`);
    }
    ids.add(entry.id);
    if (!isText(entry.prompt) || !isText(entry.expected_output)) {
      problems.push(`eval ${String(entry.id)}: prompt and expected_output must be text`);
    }
    if (!Array.isArray(entry.assertions) || !entry.assertions.length) {
      problems.push(`eval ${String(entry.id)}: no assertions`);
    } else if (!entry.assertions.every(isText)) {
      problems.push(`eval ${String(entry.id)}: an assertion is not text`);
    }
    if (!Array.isArray(entry.files) || !entry.files.every((file) => typeof file === 'string')) {
      problems.push(`eval ${String(entry.id)}: files must be an array of paths`);
    }
  }
  return problems;
}

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

export function runBash(script: string, args: string[], env: Record<string, string> = {}): Run {
  const result = Bun.spawnSync(['bash', join(ROOT, script), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** Commands that only record their call in `<dir>/calls.log`; returns that path. */
export function fakeCommands(dir: string, names: readonly string[]): string {
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'calls.log');
  for (const name of names) {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 97\n`);
    chmodSync(path, 0o755);
  }
  return log;
}
