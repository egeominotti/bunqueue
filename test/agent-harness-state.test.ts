/**
 * Agent harness contract, part 2: state, scope, verification and packaging
 * (learn-harness-engineering, `skills/harness-creator`; see docs/agents/README.md).
 *
 * Run: bun test test/agent-harness
 *
 * - State: `feature_list.json` (work items, statuses, dependencies, evidence) and
 *   `progress.md` (current state and restart notes);
 * - Scope: one in-progress item per branch, dependencies that exist and form no cycle,
 *   items in id order so parallel worktrees insert them without adjacent conflicts;
 * - Lifecycle: `session-handoff.md`, the template for a handoff note;
 * - Verification: `init.sh`, the fast startup check (pinned Bun version, frozen
 *   lockfile, `bun check`, `bun fmt`), fail-fast and Bun-native only;
 * - Packaging: no harness file ships to npm, and the sandbox test image carries every
 *   file this contract reads (a host-only pass hid an ENOENT in the unit container).
 */

import { describe, expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  INSTRUCTION_FILES,
  ROOT,
  STATE_ARTIFACTS,
  STATUSES,
  agentPages,
  copiedBy,
  copySources,
  evidenceProblems,
  harnessMarkdown,
  headings,
  publishedByFiles,
  read,
  relativeLinks,
  workItems,
} from './agent-harness-support';

describe('agent harness: state and scope', () => {
  test('feature_list.json items are well formed', () => {
    const items = workItems();
    expect(items.length).toBeGreaterThan(0);
    const problems: string[] = [];
    const ids = new Set<string>();
    for (const item of items) {
      if (typeof item.id !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(item.id)) {
        problems.push(`bad id: ${String(item.id)}`);
      }
      if (ids.has(item.id)) problems.push(`duplicate id: ${item.id}`);
      ids.add(item.id);
      for (const field of ['name', 'description', 'evidence'] as const) {
        if (typeof item[field] !== 'string') problems.push(`${item.id}: ${field} is not a string`);
      }
      if (!STATUSES.includes(item.status)) problems.push(`${item.id}: status ${item.status}`);
      if (!Array.isArray(item.dependencies)) problems.push(`${item.id}: dependencies`);
      if (item.status === 'done' && !item.evidence?.trim()) {
        problems.push(`${item.id}: done without evidence`);
      }
      if (item.status === 'in-progress' && !item.branch?.trim()) {
        problems.push(`${item.id}: in-progress without a branch`);
      }
    }
    expect(problems).toEqual([]);
  });

  test('the evidence heuristic wants a command and an artifact path or a hash', () => {
    expect(evidenceProblems('All green, should be fine.')).toHaveLength(2);
    expect(evidenceProblems('bun run test:sandbox green: unit 11668 / 0.')).toHaveLength(1);
    expect(evidenceProblems('Commit da289219 on main; everything passed.')).toHaveLength(1);
    // A count, a run id or a date is not a commit or tree hash.
    expect(evidenceProblems('bun test test/x.test.ts 11668 / 0, run 43336453775.')).toHaveLength(1);
    expect(evidenceProblems('./init.sh green on tree bbd565ca.')).toEqual([]);
    expect(
      evidenceProblems(
        'bun run test:sandbox green (artifacts/test-sandbox/2026-11-12T20-20-16.500Z/).'
      )
    ).toEqual([]);
  });

  test('every done item names a command and an artifact path or a commit or tree hash', () => {
    const problems = workItems()
      .filter((item) => item.status === 'done')
      .flatMap((item) =>
        evidenceProblems(item.evidence).map((problem) => `${item.id}: done evidence ${problem}`)
      );
    expect(problems).toEqual([]);
  });

  test('feature_list.json keeps its items in id order', () => {
    const ids = workItems().map((item) => item.id);
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  test('dependencies exist, form no cycle, and a done item depends only on done items', () => {
    const items = workItems();
    const byId = new Map(items.map((item) => [item.id, item]));
    const problems: string[] = [];
    for (const item of items) {
      for (const dependency of item.dependencies) {
        const target = byId.get(dependency);
        if (!target) problems.push(`${item.id} -> missing ${dependency}`);
        else if (item.status === 'done' && target.status !== 'done') {
          problems.push(`${item.id} is done but ${dependency} is ${target.status}`);
        }
      }
    }
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (id: string, path: string[]): void => {
      if (state.get(id) === 'done') return;
      if (state.get(id) === 'visiting') {
        problems.push(`cycle: ${[...path, id].join(' -> ')}`);
        return;
      }
      state.set(id, 'visiting');
      for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency, [...path, id]);
      state.set(id, 'done');
    };
    for (const item of items) visit(item.id, []);
    expect(problems).toEqual([]);
  });

  test('one work item at a time: at most one in-progress item per branch', () => {
    const perBranch = new Map<string, string[]>();
    for (const item of workItems().filter((entry) => entry.status === 'in-progress')) {
      perBranch.set(item.branch!, [...(perBranch.get(item.branch!) ?? []), item.id]);
    }
    const crowded = [...perBranch].filter(([, ids]) => ids.length > 1);
    expect(crowded).toEqual([]);
  });

  test('progress.md supports a restart', () => {
    const progress = read('progress.md');
    const titles = headings(progress).join('\n');
    for (const section of ['Current State', 'Blockers', 'Next']) {
      expect({ section, present: titles.includes(section) }).toEqual({ section, present: true });
    }
    expect(progress).toMatch(/\*\*Last Updated:\*\*\s+\d{4}-\d{2}-\d{2}/);
  });

  test('session-handoff.md is a complete handoff template', () => {
    const titles = headings(read('session-handoff.md')).join('\n');
    for (const section of [
      'Current Objective',
      'Verification Evidence',
      'Files Changed',
      'Blockers',
      'Next Session Startup',
      'Recommended Next Step',
    ]) {
      expect({ section, present: titles.includes(section) }).toEqual({ section, present: true });
    }
  });
});

describe('agent harness: verification entrypoint', () => {
  test('init.sh is an executable, fail-fast bash script', () => {
    const script = read('init.sh');
    expect(script.startsWith('#!/usr/bin/env bash\n') || script.startsWith('#!/bin/bash\n')).toBe(
      true
    );
    expect(script).toContain('set -euo pipefail');
    expect(statSync(join(ROOT, 'init.sh')).mode & 0o111).not.toBe(0);
  });

  test('init.sh checks the CI Bun version and runs the Bun-native gates', () => {
    const script = read('init.sh');
    // The pinned version is read from CI, never duplicated in the script.
    expect(script).toContain('.github/workflows/ci.yml');
    expect(script).toContain('BUN_VERSION');
    for (const command of [
      'bun install --frozen-lockfile',
      'bun run typecheck',
      'bun run format:check',
      'git diff --check',
      'bun test test/agent-harness',
    ]) {
      expect({ command, present: script.includes(command) }).toEqual({ command, present: true });
    }
    // Bun-native tooling only (CLAUDE.md): no other type checker, linter or formatter.
    for (const forbidden of ['tsc --noEmit', 'eslint', 'prettier', 'biome', 'oxlint', 'dprint']) {
      expect({ forbidden, present: script.includes(forbidden) }).toEqual({
        forbidden,
        present: false,
      });
    }
  });
});

describe('agent harness: packaging', () => {
  test('npm `files` matching honors globs, directories and negations', () => {
    const files = ['dist/**/*.js', '!dist/benchmark', 'README.md', 'docs/'];
    expect(publishedByFiles(files, 'dist/client/index.js')).toBe(true);
    expect(publishedByFiles(files, 'dist/benchmark/run.js')).toBe(false);
    expect(publishedByFiles(files, 'README.md')).toBe(true);
    expect(publishedByFiles(files, 'docs/agents/README.md')).toBe(true);
    expect(publishedByFiles(files, 'progress.md')).toBe(false);
  });

  test('the harness files are not published to npm', () => {
    const files = (JSON.parse(read('package.json')) as { files: string[] }).files;
    const published = [...INSTRUCTION_FILES, ...STATE_ARTIFACTS, ...agentPages()].filter((path) =>
      publishedByFiles(files, path)
    );
    expect(published).toEqual([]);
  });

  test('COPY sources are read from continued lines, and an unreadable COPY is an error', () => {
    const multiLine = [
      'COPY --chown=bun:bun package.json bun.lock ./',
      'COPY --chown=bun:bun \\',
      '    CLAUDE.md \\',
      '    # a comment inside the continuation',
      '    ./docs/agents/ \\',
      '    ./',
      'RUN cp a b',
    ].join('\n');
    expect(copySources(multiLine)).toEqual([
      'package.json',
      'bun.lock',
      'CLAUDE.md',
      'docs/agents',
    ]);
    for (const unreadable of [
      'COPY ["CLAUDE.md", "./"]',
      'COPY --from=build /out ./out',
      'COPY <<EOF /etc/motd',
      'COPY CLAUDE.md',
    ]) {
      expect(() => copySources(unreadable)).toThrow(/COPY the harness contract cannot read/);
    }
  });

  test('the sandbox test image contains every file the harness contract reads', () => {
    const sources = copySources(read('Dockerfile.test'));
    expect(sources).toContain('src');
    const needed = new Set<string>([
      'package.json',
      'bunfig.toml',
      'Dockerfile.test',
      ...INSTRUCTION_FILES,
      ...STATE_ARTIFACTS,
      ...agentPages(),
      ...harnessMarkdown().flatMap((file) => relativeLinks(file).map((link) => link.path)),
    ]);
    expect([...needed].filter((path) => !copiedBy(sources, path)).sort()).toEqual([]);
  });
});
