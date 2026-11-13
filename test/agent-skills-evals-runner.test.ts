/**
 * Agent Skills contract, part 7: the trigger-eval runner
 * (`scripts/agents/run-skill-evals.ts`, docs/agents/skill-evals.md).
 *
 * Run: bun test test/agent-skills
 *
 * A real run starts paid agent sessions, so the contract only covers what must never
 * start one: `--help`, a usage error, and `--dry-run`, which prints the planned
 * read-only commands for every agent and runs none. The agent CLIs and `git` are
 * replaced by recorders that must stay empty, and no report directory may appear.
 * The runner is type checked here, with the test project's options.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './agent-harness-support';
import { fakeCommands } from './agent-skills-support';

const RUNNER = 'scripts/agents/run-skill-evals.ts';
const AGENTS = ['claude', 'codex', 'gemini'];
const scratch = mkdtempSync(join(tmpdir(), 'bunqueue-skill-evals-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const callLog = fakeCommands(join(scratch, 'fakes'), [...AGENTS, 'git']);

function runner(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, join(ROOT, RUNNER), ...args], {
    cwd: ROOT,
    env: { ...process.env, PATH: `${join(scratch, 'fakes')}:${process.env.PATH}` },
    stdin: 'ignore',
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}
const reports = (): string[] => {
  const dir = join(ROOT, 'artifacts/skill-evals');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};

describe('skill trigger-eval runner', () => {
  test('the runner type checks with the test project and is in the formatted tree', () => {
    // tsconfig.test.json covers src and test; a script is only checked when a test
    // imports it, and this one cannot be imported (it runs on load), so it is checked here.
    const check = Bun.spawnSync(
      [process.execPath, 'check', '--no-script', '-p', 'tsconfig.test.json', RUNNER],
      { cwd: ROOT, stdin: 'ignore' }
    );
    expect({
      code: check.exitCode,
      output: check.exitCode === 0 ? '' : `${check.stdout}${check.stderr}`,
    }).toEqual({ code: 0, output: '' });
    const scripts = (
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts['format:check']).toMatch(/ scripts( |$)/);
  });

  test('--help prints the usage and an unknown option is an error', () => {
    const help = runner('--help');
    expect(help.code).toBe(0);
    for (const needle of ['Usage:', '--dry-run', '--agent claude|codex|gemini', '--limit']) {
      expect(help.stdout).toContain(needle);
    }
    const bad = runner('--no-such-option');
    expect(bad.code).not.toBe(0);
    expect(bad.stdout + bad.stderr).toContain('unknown option');
    expect(existsSync(callLog)).toBe(false);
  });

  for (const agent of AGENTS) {
    test(`--dry-run --agent ${agent} plans read-only sessions and starts none`, () => {
      const before = reports();
      const dry = runner('--dry-run', '--agent', agent, '--skill', 'bunqueue-dev', '--limit', '1');
      expect({ code: dry.code, stderr: dry.stderr }).toEqual({ code: 0, stderr: '' });
      expect(dry.stdout).toContain('# 2 sessions');
      expect(dry.stdout).toMatch(new RegExp(`^${agent} `, 'm'));
      expect(dry.stdout).toMatch(/--permission-mode plan|--sandbox read-only|--approval-mode plan/);
      expect({ agent, recorded: existsSync(callLog) ? readFileSync(callLog, 'utf8') : '' }).toEqual(
        {
          agent,
          recorded: '',
        }
      );
      expect(reports()).toEqual(before);
    });
  }
});
