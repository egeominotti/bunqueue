/**
 * Agent harness contract, part 1: the instruction files (learn-harness-engineering,
 * `skills/harness-creator`; see docs/agents/README.md).
 *
 * Run: bun test test/agent-harness
 *
 * `CLAUDE.md` (Claude Code) and `AGENTS.md` (Codex) are short routing pages with the
 * mandatory invariants, a startup workflow, a definition of done and an end-of-session
 * routine; reference material lives in linked docs (progressive disclosure), and every
 * relative link and anchor of the harness docs resolves. Each check names the file and
 * the rule it breaks, so a rule dropped while trimming, or a moved heading, is caught
 * by the unit suite.
 */

import { describe, expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  INSTRUCTION_FILES,
  type InstructionFile,
  ROOT,
  STATE_ARTIFACTS,
  anchors,
  harnessMarkdown,
  headings,
  linkProblems,
  missingNeedles,
  read,
  slug,
  structured,
} from './agent-harness-support';

/** Progressive disclosure: the root pages route, the manuals live in docs. */
const INSTRUCTION_BUDGET_BYTES = 12 * 1024;

const NO_AUTHORIZATION_RULE =
  "A work item, a progress note or a handoff never authorizes a commit, push, version bump, release or publication; only the user's explicit request does.";

/** Rules every instruction file states: parallel worktrees and privacy. */
const SHARED_RULES = [
  NO_AUTHORIZATION_RULE,
  'without any account/user prefix',
  'insert new items in id order',
  '`feature_list.json` keeps both items, ids unique',
  '`**Last Updated:**` takes the newest date',
  'the Session Log keeps both entries, newest first',
  '`FAIL` blocks',
  '`CONDITIONAL` requires',
  '300 lines',
  'OrbStack',
  'docs/testing.md',
  'docs/src/content/docs/changelog.md',
  'trusted publishing',
  'generate-release-posts.ts',
  'bun check',
  'bun fmt',
  '--no-script',
  'skeptic',
] as const;

/** The sandbox gate itself: `bun run test:sandbox:sdk` must not satisfy it. */
const SANDBOX_GATE = /bun run test:sandbox(?!:)/;

/** Invariants each instruction file must keep (the mandatory gates and rules). */
const INVARIANTS: Record<InstructionFile, readonly (string | RegExp)[]> = {
  'CLAUDE.md': [
    ...SHARED_RULES,
    '.claude/agents/skeptic.md',
    'ENGLISH ONLY',
    'When I report a bug',
    SANDBOX_GATE,
    'bun run test:model',
    'bun run test:sandbox:sdk',
    'git push origin main',
    "only with the user's explicit authorization",
    'only when the user explicitly requests',
    'does not replace the changelog rule',
  ],
  'AGENTS.md': [
    ...SHARED_RULES,
    '.codex/agents/skeptic.toml',
    'English',
    'regression test',
    SANDBOX_GATE,
    'bun run test:model',
    'bun run test:sandbox:sdk',
    'Do not create commits, push',
    'unless the user explicitly authorizes the relevant action',
  ],
};

describe('agent harness: instructions', () => {
  for (const file of INSTRUCTION_FILES) {
    test(`${file} is a short routing page`, () => {
      const size = statSync(join(ROOT, file)).size;
      expect({ file, size, withinBudget: size <= INSTRUCTION_BUDGET_BYTES }).toEqual({
        file,
        size,
        withinBudget: true,
      });
    });

    test(`${file} has the startup, done and end-of-session sections`, () => {
      const titles = headings(read(file)).join('\n');
      for (const section of ['Startup Workflow', 'Definition of Done', 'End of Session']) {
        expect({ file, section, present: titles.includes(section) }).toEqual({
          file,
          section,
          present: true,
        });
      }
    });

    test(`${file} routes to every state and verification artifact`, () => {
      const rules = structured(read(file));
      for (const artifact of STATE_ARTIFACTS.map((path) =>
        path === 'init.sh' ? './init.sh' : path
      )) {
        expect({ file, artifact, routed: rules.includes(artifact) }).toEqual({
          file,
          artifact,
          routed: true,
        });
      }
      for (const rule of ['One work item at a time', 'Stay in scope']) {
        expect({ file, rule, present: rules.includes(rule) }).toEqual({
          file,
          rule,
          present: true,
        });
      }
    });

    test(`${file} keeps every mandatory invariant`, () => {
      expect({ file, missing: missingNeedles(read(file), INVARIANTS[file]) }).toEqual({
        file,
        missing: [],
      });
    });
  }

  test('the sandbox invariant is not satisfied by the SDK gate alone', () => {
    expect(
      missingNeedles('run `bun run test:sandbox:sdk` after sdk/ changes', [SANDBOX_GATE])
    ).toHaveLength(1);
    expect(missingNeedles('run `bun run test:sandbox` before committing', [SANDBOX_GATE])).toEqual(
      []
    );
  });

  test('every relative link and anchor of the harness docs resolves', () => {
    const files = harnessMarkdown();
    expect(files).toContain('docs/agents/README.md');
    expect(files.flatMap(linkProblems)).toEqual([]);
  });

  test('anchors follow GitHub headings and ignore code blocks', () => {
    expect(slug('Commits, pushes and releases')).toBe('commits-pushes-and-releases');
    expect(slug('Work items: `feature_list.json`')).toBe('work-items-feature_listjson');
    expect(slug('2026-11-12 — agent-harness')).toBe('2026-11-12--agent-harness');
    expect([...anchors('# A\n\n```bash\n# Server\n```\n\n## A\n')]).toEqual(['a', 'a-1']);
  });
});
