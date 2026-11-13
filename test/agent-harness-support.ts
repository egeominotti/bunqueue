/**
 * Shared helpers for the agent harness contract (`test/agent-harness-*.test.ts`, run
 * with `bun test test/agent-harness`). The harness is described in
 * `docs/agents/README.md`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dir, '..');
export const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

export const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md'] as const;
export type InstructionFile = (typeof INSTRUCTION_FILES)[number];

/** The root state and verification artifacts both instruction files route to. */
export const STATE_ARTIFACTS = [
  'feature_list.json',
  'progress.md',
  'session-handoff.md',
  'init.sh',
] as const;

/** The agent reference pages, `docs/agents/*.md`. */
export function agentPages(): string[] {
  return [...new Bun.Glob('docs/agents/*.md').scanSync({ cwd: ROOT })].sort();
}

/** Every harness Markdown file whose links must resolve. */
export function harnessMarkdown(): string[] {
  return [...INSTRUCTION_FILES, 'progress.md', 'session-handoff.md', ...agentPages()];
}

/** The document with every fenced code block blanked out; line numbers are kept. */
export function withoutFences(markdown: string): string {
  let fence: string | null = null;
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      const marker = /^\s*(```|~~~)/.exec(line)?.[1];
      if (marker && (fence === null || fence === marker)) {
        fence = fence === null ? marker : null;
        return '';
      }
      return fence === null ? line : '';
    })
    .join('\n');
}

/** Headings, list items, table rows and bold lead-ins: where load-bearing rules live. */
export function structured(markdown: string): string {
  return withoutFences(markdown)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(#{1,6}\s|[-*+]\s|\d+\.\s|\||\*\*[^*]+\*\*)/.test(line))
    .join('\n');
}

export function headings(markdown: string): string[] {
  return withoutFences(markdown)
    .split('\n')
    .filter((line) => /^#{1,6}\s/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, '').trim());
}

/** GitHub's heading anchor: lower case, punctuation dropped, each space a hyphen. */
export function slug(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** Every heading anchor of a document; a repeated heading gets `-1`, `-2`, ... */
export function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const result = new Set<string>();
  for (const title of headings(markdown)) {
    const base = slug(title);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    result.add(count === 0 ? base : `${base}-${count}`);
  }
  return result;
}

/**
 * The text without its inline code spans. A span opens with a run of N backticks and
 * closes at the next run of exactly N on the same line (CommonMark), so a
 * double-backtick span may hold single backticks; an unclosed run stays as text.
 */
export function withoutInlineCode(markdown: string): string {
  let out = '';
  let index = 0;
  const run = (from: number): number => {
    let length = 0;
    while (markdown[from + length] === '`') length++;
    return length;
  };
  while (index < markdown.length) {
    if (markdown[index] !== '`') {
      out += markdown[index++];
      continue;
    }
    const open = run(index);
    let cursor = index + open;
    let close = -1;
    while (cursor < markdown.length && markdown[cursor] !== '\n') {
      const length = run(cursor);
      if (length === open) {
        close = cursor;
        break;
      }
      cursor += Math.max(length, 1);
    }
    if (close === -1) out += markdown.slice(index, index + open);
    index = close === -1 ? index + open : close + open;
  }
  return out;
}

export interface RelativeLink {
  target: string;
  /** Repository-relative path of the target (the file itself for `#anchor`). */
  path: string;
  fragment: string | null;
}

/** Relative markdown links outside code (no URL), resolved from `file`. */
export function relativeLinks(file: string): RelativeLink[] {
  const text = withoutInlineCode(withoutFences(read(file)));
  const links: RelativeLink[] = [];
  for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1]!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const hash = target.indexOf('#');
    const rawPath = hash === -1 ? target : target.slice(0, hash);
    const fragment = hash === -1 ? null : decodeURIComponent(target.slice(hash + 1));
    const path = rawPath ? normalize(join(dirname(file), rawPath)).replace(/\/$/, '') : file;
    links.push({ target, path, fragment });
  }
  return links;
}

/** Broken links of `file`: a missing target, or an anchor no heading of it defines. */
export function linkProblems(file: string): string[] {
  const problems: string[] = [];
  for (const { target, path, fragment } of relativeLinks(file)) {
    if (!existsSync(join(ROOT, path))) problems.push(`${file}: ${target} (no ${path})`);
    else if (fragment !== null && !path.endsWith('.md')) {
      problems.push(`${file}: ${target} (anchor into a non-Markdown file)`);
    } else if (fragment !== null && !anchors(read(path)).has(fragment)) {
      problems.push(`${file}: ${target} (no heading #${fragment} in ${path})`);
    }
  }
  return problems;
}

/** Needles absent from `text`; whitespace is normalized, so wrapped lines still match. */
export function missingNeedles(text: string, needles: readonly (string | RegExp)[]): string[] {
  const flat = text.replace(/\s+/g, ' ');
  return needles
    .filter((needle) => (typeof needle === 'string' ? !flat.includes(needle) : !needle.test(flat)))
    .map(String);
}

/**
 * Whether npm would pack `path` under a package.json `files` list: patterns apply in
 * order, a later match overrides an earlier one, `!` negates, and a pattern that names
 * a directory covers everything below it.
 */
export function publishedByFiles(patterns: readonly string[], path: string): boolean {
  let published = false;
  for (const raw of patterns) {
    const negated = raw.startsWith('!');
    const pattern = (negated ? raw.slice(1) : raw).replace(/^\.\//, '').replace(/\/$/, '');
    if (new Bun.Glob(pattern).match(path) || new Bun.Glob(`${pattern}/**`).match(path)) {
      published = !negated;
    }
  }
  return published;
}

/** Dockerfile instructions: comments dropped, backslash-continued lines joined. */
export function dockerInstructions(dockerfile: string): string[] {
  const instructions: string[] = [];
  let pending = '';
  for (const raw of dockerfile.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const continued = line.endsWith('\\');
    pending += `${continued ? line.slice(0, -1).trim() : line} `;
    if (continued) continue;
    instructions.push(pending.trim());
    pending = '';
  }
  if (pending.trim()) instructions.push(pending.trim());
  return instructions;
}

/**
 * Build-context sources of every `COPY` instruction of a Dockerfile, single-line or
 * continued with backslashes. The JSON form, a heredoc and `--from` (another stage,
 * not the build context) are not parsed: they throw, so the contract fails with the
 * instruction instead of passing on a source it never saw.
 */
export function copySources(dockerfile: string): string[] {
  const sources: string[] = [];
  for (const instruction of dockerInstructions(dockerfile)) {
    const rest = /^COPY\s+(.+)$/i.exec(instruction)?.[1];
    if (rest === undefined) continue;
    const args = rest.split(/\s+/);
    const paths = args.filter((arg) => !arg.startsWith('--'));
    const unsupported =
      paths[0]?.startsWith('[') ||
      rest.includes('<<') ||
      args.some((arg) => arg.startsWith('--from'));
    if (unsupported || paths.length < 2) {
      throw new Error(
        `Dockerfile COPY the harness contract cannot read (use the shell form, "COPY [--chown=...] <source>... <destination>", from the build context): ${instruction}`
      );
    }
    sources.push(...paths.slice(0, -1).map((source) => source.replace(/^\.\//, '')));
  }
  return sources.map((source) => source.replace(/\/$/, ''));
}

/** Whether a `COPY` source puts `path` (a file or a directory) into the image. */
export function copiedBy(sources: readonly string[], path: string): boolean {
  return sources.some(
    (source) => source === path || path.startsWith(`${source}/`) || new Bun.Glob(source).match(path)
  );
}

export interface WorkItem {
  id: string;
  name: string;
  description: string;
  status: string;
  dependencies: string[];
  evidence: string;
  branch?: string;
  issue?: number | null;
}

export const STATUSES = ['not-started', 'in-progress', 'blocked', 'done'];

const EVIDENCE_COMMAND = /\bbun (?:run [\w:.-]+|test\b|check\b|fmt\b)|\.\/init\.sh\b/;
const EVIDENCE_ARTIFACT = /\bartifacts\/[\w.-]+\/[\w./-]+/;
/** A commit or tree hash: 7-64 hex characters with a digit and a letter (not a count). */
const EVIDENCE_HASH = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,64}\b/;

/**
 * What the evidence of a `done` item lacks. A light heuristic, not a proof: it names at
 * least one command, and either an artifact path or a commit or tree hash, so "all
 * green" alone never closes an item.
 */
export function evidenceProblems(evidence: string): string[] {
  const problems: string[] = [];
  if (!EVIDENCE_COMMAND.test(evidence)) {
    problems.push('names no command (for example `bun run test:sandbox`, `bun test <file>`)');
  }
  if (!EVIDENCE_ARTIFACT.test(evidence) && !EVIDENCE_HASH.test(evidence)) {
    problems.push(
      'names neither an artifact path (artifacts/<gate>/<run>/) nor a commit or tree hash'
    );
  }
  return problems;
}

export function workItems(): WorkItem[] {
  const parsed = JSON.parse(read('feature_list.json')) as { features?: unknown };
  if (!Array.isArray(parsed.features)) throw new Error('feature_list.json: no features[]');
  return parsed.features as WorkItem[];
}
