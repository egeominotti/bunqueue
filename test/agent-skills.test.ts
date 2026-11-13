/**
 * Agent Skills contract, part 1: layout, frontmatter, links and evals (see
 * docs/agents/README.md#skills).
 *
 * Run: bun test test/agent-skills
 *
 * `.agents/skills/<name>/` is the canonical, cross-client location (Codex, Gemini CLI,
 * Cursor, Copilot); Claude Code reads `.claude/skills/<name>`, which is one relative
 * symlink per skill. Each skill uses the portable frontmatter only, keeps SKILL.md
 * short with its details one level deep, links every bundled file, resolves every
 * link inside the repository, and ships trigger and output evals. The sandbox test
 * image must carry all of it, or this contract fails in the unit container only.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import {
  ROOT,
  copiedBy,
  copySources,
  headings,
  linkProblems,
  publishedByFiles,
  read,
  relativeLinks,
} from './agent-harness-support';
import {
  BUNDLED_DIRS,
  CLAUDE_SKILLS_DIR,
  SKILLS_DIR,
  SKILL_ENTRIES,
  descriptionLineProblems,
  descriptionProblems,
  evalsProblems,
  frontmatterProblems,
  nameProblems,
  parseSkill,
  skillFiles,
  skillNames,
} from './agent-skills-support';

const markdownOf = (name: string): string[] =>
  skillFiles(name).filter((path) => path.endsWith('.md'));

describe('agent skills: layout', () => {
  test('there are skills, each with a SKILL.md and only the standard entries', () => {
    const names = skillNames();
    expect(names.length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const name of names) {
      const entries = readdirSync(join(ROOT, SKILLS_DIR, name));
      if (!entries.includes('SKILL.md')) problems.push(`${name}: no SKILL.md`);
      for (const entry of entries.filter((item) => !SKILL_ENTRIES.includes(item))) {
        problems.push(`${name}: unexpected entry ${entry}`);
      }
      for (const file of skillFiles(name)) {
        if (/^(readme|changelog)\.md$/i.test(basename(file)))
          problems.push(`${file}: not in a skill`);
        if (/\/references\/.+\//.test(file))
          problems.push(`${file}: references are one level deep`);
      }
    }
    expect(problems).toEqual([]);
  });

  test('.claude/skills holds exactly one relative symlink per skill', () => {
    const entries = readdirSync(join(ROOT, CLAUDE_SKILLS_DIR)).sort();
    expect(entries).toEqual(skillNames());
    for (const name of entries) {
      const path = join(ROOT, CLAUDE_SKILLS_DIR, name);
      const link = lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
      expect({ name, link }).toEqual({ name, link: `../../${SKILLS_DIR}/${name}` });
      expect({ name, resolves: existsSync(join(path, 'SKILL.md')) }).toEqual({
        name,
        resolves: true,
      });
    }
  });

  test('no skill file is packed for npm', () => {
    const files = (JSON.parse(read('package.json')) as { files: string[] }).files;
    const paths = [
      ...skillNames().flatMap(skillFiles),
      ...skillNames().map((n) => `${CLAUDE_SKILLS_DIR}/${n}`),
    ];
    expect(paths.filter((path) => publishedByFiles(files, path))).toEqual([]);
  });

  test('the sandbox test image contains the skills and every path they link to', () => {
    const sources = copySources(read('Dockerfile.test'));
    const needed = new Set<string>([CLAUDE_SKILLS_DIR, ...skillNames().flatMap(skillFiles)]);
    for (const name of skillNames()) {
      for (const file of markdownOf(name)) {
        for (const link of relativeLinks(file)) needed.add(link.path);
      }
    }
    expect([...needed].filter((path) => !copiedBy(sources, path)).sort()).toEqual([]);
  });
});

describe('agent skills: SKILL.md', () => {
  test('the frontmatter rules reject what the specification rejects', () => {
    expect(nameProblems('bunqueue-fixing-bugs', 'bunqueue-fixing-bugs')).toEqual([]);
    for (const bad of ['Bad', 'a--b', '-a', 'a-', 'a_b', 'claude-x', 'x'.repeat(65)]) {
      expect({ bad, rejected: nameProblems(bad, bad).length > 0 }).toEqual({ bad, rejected: true });
    }
    expect(nameProblems('a-b', 'a-c')).toHaveLength(1);
    expect(descriptionProblems('Does X. Use when Y.')).toEqual([]);
    expect(descriptionLineProblems('name: a\ndescription: "Does X: y. Use when Z."')).toEqual([]);
    expect(descriptionLineProblems("description: 'it''s fine'")).toEqual([]);
    expect(descriptionLineProblems('description: >-\n  Does X.')).toHaveLength(1);
    expect(descriptionLineProblems('description: Does X.')).toHaveLength(1);
    expect(descriptionProblems('Does <X>. Use when Y.')).toHaveLength(1);
    expect(descriptionProblems('Does X.')).toHaveLength(1);
    expect(descriptionProblems(`Use when ${'x'.repeat(1020)}`)).toHaveLength(1);
    expect(
      frontmatterProblems({ name: 'a', description: 'b', 'allowed-tools': 'Read' })
    ).toHaveLength(1);
    expect(frontmatterProblems({ name: 'a', description: 'b', metadata: { n: 1 } })).toHaveLength(
      1
    );
  });

  for (const name of skillNames()) {
    test(`${name}: portable frontmatter and a short body with gotchas`, () => {
      const { raw, frontmatter, body } = parseSkill(name);
      expect({
        name,
        problems: [
          ...descriptionLineProblems(raw),
          ...frontmatterProblems(frontmatter),
          ...nameProblems(frontmatter.name, name),
          ...descriptionProblems(frontmatter.description),
        ],
      }).toEqual({ name, problems: [] });
      expect({ name, lines: body.split('\n').length < 500 }).toEqual({ name, lines: true });
      expect({ name, gotchas: headings(body).includes('Gotchas') }).toEqual({
        name,
        gotchas: true,
      });
    });

    test(`${name}: links resolve inside the repository and every bundled file is linked`, () => {
      const problems = markdownOf(name).flatMap(linkProblems);
      for (const file of markdownOf(name)) {
        for (const link of relativeLinks(file)) {
          if (isAbsolute(link.path) || link.path.startsWith('..')) {
            problems.push(`${file}: ${link.target} leaves the repository`);
          }
        }
        const lines = read(file).split('\n').length;
        if (
          file.includes('/references/') &&
          lines > 100 &&
          !headings(read(file)).includes('Contents')
        ) {
          problems.push(`${file}: ${lines} lines need a Contents section`);
        }
      }
      const linked = new Set(
        relativeLinks(`${SKILLS_DIR}/${name}/SKILL.md`).map((link) => link.path)
      );
      for (const file of skillFiles(name)) {
        const dir = file.slice(`${SKILLS_DIR}/${name}/`.length).split('/')[0]!;
        if (BUNDLED_DIRS.includes(dir) && !linked.has(file))
          problems.push(`${file}: not linked from SKILL.md`);
      }
      expect(problems).toEqual([]);
    });

    test(`${name}: evals/evals.json has trigger queries and output scenarios`, () => {
      const path = `${SKILLS_DIR}/${name}/evals/evals.json`;
      expect({ path, exists: existsSync(join(ROOT, path)) }).toEqual({ path, exists: true });
      expect({ name, problems: evalsProblems(name, read(path)) }).toEqual({ name, problems: [] });
    });

    test(`${name}: Codex metadata, when present, is valid and matches the invocation rule`, () => {
      const path = `${SKILLS_DIR}/${name}/agents/openai.yaml`;
      const explicitOnly = /explicitly asks/.test(String(parseSkill(name).frontmatter.description));
      if (!existsSync(join(ROOT, path))) {
        expect({ name, explicitOnly }).toEqual({ name, explicitOnly: false });
        return;
      }
      const yaml = Bun.YAML.parse(read(path)) as {
        interface?: Record<string, unknown>;
        policy?: { allow_implicit_invocation?: unknown };
      };
      for (const value of Object.values(yaml.interface ?? {})) expect(typeof value).toBe('string');
      const implicit = yaml.policy?.allow_implicit_invocation;
      expect(implicit === undefined || typeof implicit === 'boolean').toBe(true);
      if (explicitOnly) expect({ name, implicit }).toEqual({ name, implicit: false });
      // Other clients load a skill from its description alone, so a skill Codex may
      // not invoke implicitly opens with the guard that stops without the request.
      if (implicit === false) {
        const opening = parseSkill(name).body.split(/\n## /)[0]!.replace(/\s+/g, ' ');
        for (const needle of ['Claude Code and other clients can', 'first step is the guard']) {
          expect({ name, needle, present: opening.includes(needle) }).toEqual({
            name,
            needle,
            present: true,
          });
        }
      }
    });
  }
});
