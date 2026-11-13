/**
 * Agent harness contract, part 3: `init.sh`, the startup check (see
 * docs/agents/README.md#initsh).
 *
 * Run: bun test test/agent-harness
 *
 * - `./init.sh --workspace` prints the workspace and stops, so the Git detection is
 *   testable without the install and type-check steps;
 * - a checkout is detected by asking Git (an empty `--show-prefix`), also through a
 *   path typed in another case on a case-insensitive volume, where comparing
 *   `pwd -P` with `git rev-parse --show-toplevel` skipped the git steps;
 * - a copy that is not the root of a checkout (a sanitized Machine snapshot, a
 *   directory nested in another repository) skips them with a notice;
 * - `init.sh` runs the fast contract only: every harness and skills contract test
 *   except the listed slow ones, which stay in the unit suite.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, read } from './agent-harness-support';

/**
 * Contract tests `init.sh` leaves to the unit suite (`bun test --parallel=4`, which
 * `bun run test:sandbox` runs): real process trees, settle windows and time bounds,
 * about 50 s.
 */
const SLOW_CONTRACT_TESTS = [
  'test/agent-skills-machine-lifecycle.test.ts',
  'test/agent-skills-machine-worker.test.ts',
];

const scratch = mkdtempSync(join(tmpdir(), 'bunqueue-harness-init-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const git = Bun.which('git');

/** A directory holding a copy of `init.sh`; `repository` makes it a Git checkout. */
function workspace(name: string, repository: boolean, nested = ''): string {
  const root = join(scratch, name);
  mkdirSync(join(root, nested), { recursive: true });
  if (repository) {
    expect(Bun.spawnSync(['git', 'init', '-q', root]).exitCode).toBe(0);
  }
  const script = join(root, nested, 'init.sh');
  copyFileSync(join(ROOT, 'init.sh'), script);
  chmodSync(script, 0o755);
  return join(root, nested);
}

function printWorkspace(dir: string): { code: number; stdout: string } {
  const result = Bun.spawnSync(['bash', join(dir, 'init.sh'), '--workspace'], {
    cwd: tmpdir(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: result.exitCode, stdout: result.stdout.toString() };
}

describe('agent harness: init.sh workspace detection', () => {
  test('--workspace is documented and an unknown option is a usage error', () => {
    const help = Bun.spawnSync(['bash', join(ROOT, 'init.sh'), '--help']);
    expect(help.exitCode).toBe(0);
    for (const option of ['--full', '--workspace']) {
      expect(help.stdout.toString()).toContain(option);
    }
    const bad = Bun.spawnSync(['bash', join(ROOT, 'init.sh'), '--no-such-option']);
    expect({
      code: bad.exitCode,
      stderr: bad.stderr.toString().includes('unknown option'),
    }).toEqual({ code: 2, stderr: true });
  });

  test('a directory that is not a Git checkout skips the git steps with a notice', () => {
    const run = printWorkspace(workspace('snapshot', false));
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('no Git checkout rooted here');
    expect(run.stdout).not.toContain('branch:');
  });

  test.skipIf(!git)('the root of a Git checkout is detected', () => {
    const run = printWorkspace(workspace('checkout', true));
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('branch:');
    expect(run.stdout).not.toContain('no Git checkout');
  });

  test.skipIf(!git)('a copy nested inside another checkout is not its root', () => {
    const run = printWorkspace(workspace('outer', true, 'nested/snapshot'));
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('no Git checkout rooted here');
  });

  // Only a case-insensitive volume (the default APFS) resolves the other spelling.
  const cased = workspace('Case-Checkout', false);
  const otherCase = join(scratch, 'case-checkout');
  test.skipIf(!git || !existsSync(otherCase))(
    'a checkout entered through a differently cased path is still detected',
    () => {
      expect(Bun.spawnSync(['git', 'init', '-q', cased]).exitCode).toBe(0);
      const run = printWorkspace(otherCase);
      expect(run.code).toBe(0);
      expect(run.stdout).toContain(`dir:    ${otherCase}`);
      expect(run.stdout).toContain('branch:');
      expect(run.stdout).not.toContain('no Git checkout');
    }
  );
});

describe('agent harness: init.sh runs the fast contract', () => {
  const contractTests = [
    ...new Bun.Glob('test/agent-{harness,skills}*.test.ts').scanSync({ cwd: ROOT }),
  ].sort();
  /** The path filters of the `bun test` call of init.sh (backslash continuations joined). */
  const filters = (): string[] => {
    const call = /^bun test (.+)$/m.exec(read('init.sh').replace(/\\\n\s*/g, ''))?.[1];
    return call?.split(/\s+/).filter((argument) => !argument.startsWith('-')) ?? [];
  };

  test('every contract test runs in init.sh or is listed as left to the unit suite', () => {
    expect(contractTests).toContain('test/agent-harness-init.test.ts');
    // bun test treats each filter as a substring of the test file's path.
    const inInit = contractTests.filter((file) =>
      filters().some((filter) => file.includes(filter))
    );
    expect(inInit).toEqual(contractTests.filter((file) => !SLOW_CONTRACT_TESTS.includes(file)));
  });

  test('the slow contract tests exist and stay in the unit suite', () => {
    for (const file of SLOW_CONTRACT_TESTS) {
      expect({ file, exists: existsSync(join(ROOT, file)) }).toEqual({ file, exists: true });
    }
    // The unit suite is `bun test --parallel=4`: it discovers every test file that
    // no ignore pattern of bunfig.toml matches.
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> })
      .scripts;
    expect(scripts.test).toContain('bun test --parallel=4');
    const ignored = /pathIgnorePatterns\s*=\s*\[([^\]]*)\]/.exec(read('bunfig.toml'))?.[1] ?? '';
    const patterns = [...ignored.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
    expect(patterns).toContain('artifacts/**');
    for (const file of SLOW_CONTRACT_TESTS) {
      const ignoredBy = patterns.filter((pattern) => new Bun.Glob(pattern).match(file));
      expect({ file, ignoredBy }).toEqual({ file, ignoredBy: [] });
    }
  });
});
