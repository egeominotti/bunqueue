/**
 * Agent Skills contract, part 2: the bundled scripts (see docs/agents/README.md#skills).
 *
 * Run: bun test test/agent-skills
 *
 * Every script is non-interactive bash in strict mode, at most 300 lines, with
 * `--help`, a usage error (exit 2) and a `--dry-run` that runs no external command:
 * the commands with side effects (gh, orb, ssh, rsync, git, docker, sudo, curl, bun) are
 * replaced by recorders, and a dry run must leave the record empty. The content hash
 * and the post-gate delta classification are checked on real files and, where Git is
 * installed, on a real repository (the sandbox image has no Git).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ROOT, read } from './agent-harness-support';
import { SKILLS_DIR, fakeCommands, runBash, skillFiles, skillNames } from './agent-skills-support';

const MACHINE = `${SKILLS_DIR}/bunqueue-running-machine-gates/scripts`;
const GATE = `${MACHINE}/machine-gate.sh`;
const STEPS = `${MACHINE}/machine-steps.sh`;
const DELTA = `${SKILLS_DIR}/bunqueue-running-gates/scripts/gate-delta.sh`;
const RECORDED = [
  'gh',
  'orb',
  'orbctl',
  'ssh',
  'rsync',
  'scp',
  'git',
  'docker',
  'sudo',
  'apt-get',
  'curl',
  'bun',
];

const scratch = mkdtempSync(join(tmpdir(), 'bunqueue-agent-skills-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const fakes = join(scratch, 'fakes');
const callLog = fakeCommands(fakes, RECORDED);
const faked = { PATH: `${fakes}:${process.env.PATH}` };

/** Arguments that make each script's dry run self-contained; a new script adds its own. */
const DRY_RUN_ARGS: Record<string, string[]> = {
  'machine-gate.sh': ['--dry-run', '--run-id', 'contract-dry-run'],
  'machine-worker.sh': [
    '--dry-run',
    '--distro',
    'ubuntu:24.04',
    '--name',
    'bunqueue-ci-contract',
    '--arch',
    'arm64',
    '--run-dir',
    join(scratch, 'run'),
    '--state-dir',
    join(scratch, 'state'),
    '--snapshot',
    join(scratch, 'snap'),
    '--content-hash',
    'x',
    '--bun-version',
    '1.4.4',
    '--steps',
    'unit,tcp',
  ],
  'machine-cleanup.sh': [
    '--dry-run',
    '--run-dir',
    join(scratch, 'run'),
    '--state-dir',
    join(scratch, 'state'),
    '--pids',
    '1',
  ],
  'machine-verdict.sh': ['--dry-run', scratch],
  'machine-steps.sh': ['--dry-run', '--repo', join(scratch, 'repo'), '--out', join(scratch, 'out')],
  'gate-delta.sh': ['--dry-run', '--gated', 'HEAD'],
  'ci-watch.sh': ['--dry-run', '--sha', '7bc922dbcc1f8f007cf7340a41fec3672a929e40'],
};

const scripts = skillNames().flatMap((name) =>
  skillFiles(name).filter((file) => file.includes('/scripts/'))
);

describe('agent skills: scripts', () => {
  test('the skills bundle scripts', () => {
    expect(scripts).toContain(GATE);
  });

  for (const script of scripts) {
    test(`${script}: strict, executable bash of at most 300 lines with --help and usage errors`, () => {
      const text = read(script);
      expect(text.startsWith('#!/usr/bin/env bash\n')).toBe(true);
      expect(text).toContain('set -euo pipefail');
      expect({ script, lines: text.split('\n').length - 1 <= 300 }).toEqual({
        script,
        lines: true,
      });
      expect(statSync(join(ROOT, script)).mode & 0o111).not.toBe(0);
      expect(Bun.spawnSync(['bash', '-n', join(ROOT, script)]).exitCode).toBe(0);
      const help = runBash(script, ['--help']);
      expect({ code: help.code, usage: help.stdout.includes('Usage:') }).toEqual({
        code: 0,
        usage: true,
      });
      expect(help.stdout).toContain('--dry-run');
      const bad = runBash(script, ['--no-such-option']);
      expect({ code: bad.code, stderr: bad.stderr.includes('unknown option') }).toEqual({
        code: 2,
        stderr: true,
      });
    });

    test(`${script}: --dry-run calls no external command and writes nothing`, () => {
      const args = DRY_RUN_ARGS[basename(script)];
      expect({ script, hasDryRunArgs: args !== undefined }).toEqual({
        script,
        hasDryRunArgs: true,
      });
      const run = runBash(script, args!, faked);
      expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: '' });
      expect({ script, recorded: existsSync(callLog) ? read(callLog) : '' }).toEqual({
        script,
        recorded: '',
      });
      for (const path of ['run', 'state', 'out'])
        expect(existsSync(join(scratch, path))).toBe(false);
    });
  }

  test('the Machine gate dry run plans isolated Machines, the copy back and the deletion', () => {
    const run = runBash(GATE, DRY_RUN_ARGS['machine-gate.sh']!, faked);
    for (const needle of [
      'orb create --isolated --isolate-network',
      'ubuntu:24.04 bunqueue-ci-contract-dry-run',
      'debian:13 bunqueue-debian-contract-dry-run',
      '+ orb list -q',
      '<name>@orb:gate-out/',
      '+ orb delete -f',
      'ForwardAgent=no',
      'ClearAllForwardings=yes',
    ]) {
      expect({ needle, present: run.stdout.includes(needle) }).toEqual({ needle, present: true });
    }
    for (const forbidden of ['--mount', '--forward-ssh-agent'])
      expect(run.stdout).not.toContain(forbidden);
    expect(existsSync(join(ROOT, 'artifacts/machines/contract-dry-run'))).toBe(false);
  });
});

describe('content hash and post-gate delta', () => {
  test('the content hash depends on content and symlink targets, not on creation order', () => {
    const tree = (name: string, files: [string, string][]) => {
      const dir = join(scratch, name, 'd');
      mkdirSync(dir, { recursive: true });
      for (const [path, text] of files) writeFileSync(join(dir, path), text);
      return join(scratch, name);
    };
    const hash = (dir: string) => runBash(STEPS, ['--content-hash', dir]).stdout.trim();
    const a = tree('hash-a', [
      ['x', '1'],
      ['y', '2'],
    ]);
    const b = tree('hash-b', [
      ['y', '2'],
      ['x', '1'],
    ]);
    expect(hash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hash(a)).toBe(hash(b));
    symlinkSync('d/x', join(a, 'link'));
    symlinkSync('d/y', join(b, 'link'));
    expect(hash(a)).not.toBe(hash(b));
  });

  test('gate-delta sorts listed paths into code and docs', () => {
    const classify = (paths: string) => {
      const file = join(scratch, `paths-${Bun.hash(paths)}`);
      writeFileSync(file, paths);
      return runBash(DELTA, ['--paths', file]).code;
    };
    expect(classify('')).toBe(0);
    expect(classify('docs/src/content/docs/changelog.md\nprogress.md\nfeature_list.json\n')).toBe(
      3
    );
    expect(classify('docs/testing.md\nsrc/main.ts\n')).toBe(1);
    expect(classify('docs/scripts/generate-release-posts.ts\n')).toBe(1);
    expect(classify(`${GATE}\n`)).toBe(1);
  });

  test.skipIf(!Bun.which('git'))(
    'gate-delta on a real repository: a rename counts both paths',
    () => {
      const repo = join(scratch, 'delta-repo');
      const delta = join(repo, DELTA);
      mkdirSync(join(repo, 'src'), { recursive: true });
      mkdirSync(join(repo, 'docs'), { recursive: true });
      mkdirSync(join(repo, DELTA, '..'), { recursive: true });
      writeFileSync(delta, read(DELTA));
      writeFileSync(join(repo, 'src/thing.ts'), 'export const thing = 1;\n'.repeat(20));
      writeFileSync(join(repo, 'docs/guide.md'), '# Guide\n');
      const git = (...args: string[]) => {
        const result = Bun.spawnSync([
          'git',
          '-C',
          repo,
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@example.invalid',
          ...args,
        ]);
        expect({ args, code: result.exitCode }).toEqual({ args, code: 0 });
        return result.stdout.toString().trim();
      };
      git('init', '-q');
      git('add', '-A');
      const gated = git('write-tree');
      const delta3 = () => Bun.spawnSync(['bash', delta, '--gated', gated]).exitCode;
      expect(delta3()).toBe(0);
      writeFileSync(join(repo, 'docs/guide.md'), '# Guide\n\nMore.\n');
      git('add', '-A');
      expect(delta3()).toBe(3);
      git('mv', 'src/thing.ts', 'docs/thing.md');
      expect(delta3()).toBe(1);
    }
  );
});
