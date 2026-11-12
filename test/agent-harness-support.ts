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

export interface RelativeLink {
  target: string;
  /** Repository-relative path of the target (the file itself for `#anchor`). */
  path: string;
  fragment: string | null;
}

/** Relative markdown links outside code (no URL), resolved from `file`. */
export function relativeLinks(file: string): RelativeLink[] {
  const text = withoutFences(read(file)).replace(/`[^`\n]*`/g, '');
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

/** Build-context sources of every single-line `COPY` instruction of a Dockerfile. */
export function copySources(dockerfile: string): string[] {
  const sources: string[] = [];
  for (const line of dockerfile.split(/\r?\n/)) {
    const args = /^\s*COPY\s+(.+)$/i.exec(line)?.[1]?.split(/\s+/);
    if (!args) continue;
    const paths = args.filter((arg) => !arg.startsWith('--'));
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

export function workItems(): WorkItem[] {
  const parsed = JSON.parse(read('feature_list.json')) as { features?: unknown };
  if (!Array.isArray(parsed.features)) throw new Error('feature_list.json: no features[]');
  return parsed.features as WorkItem[];
}
