/**
 * `artifacts/` holds full copies of earlier source trees (benchmark baselines,
 * regression candidates), including their `test/` directories. Bun's test
 * discovery walks every directory except `node_modules`, so a host run of
 * `bun test` or of a path-filtered script such as `bun run test:model`
 * (`test/model-based/backup-model.test.ts` is a substring filter) also executed
 * those stale copies and reported their failures as current ones.
 *
 * This runs `bun test` with the repository's real `bunfig.toml` in a scratch
 * tree that has one current test and a failing stale copy of it under
 * `artifacts/`; only the current test may run.
 */
import { afterAll, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..');
const dir = mkdtempSync(join(tmpdir(), 'bunqueue-discovery-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(path: string, contents: string): void {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), contents);
}

copyFileSync(join(REPO, 'bunfig.toml'), join(dir, 'bunfig.toml'));
write('test/preload.ts', '');
write(
  'test/model-based/probe-model.test.ts',
  "import { test } from 'bun:test';\ntest('current copy', () => {});\n"
);
write(
  'artifacts/benchmarks/run/versions/current/test/model-based/probe-model.test.ts',
  "import { test } from 'bun:test';\ntest('stale copy', () => { throw new Error('stale copy ran'); });\n"
);

async function bunTest(args: string[]): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn([process.execPath, 'test', ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? dir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: out + err };
}

test.each([
  ['a full run', []],
  ['a path-filtered run, as test:model does', ['test/model-based/probe-model.test.ts']],
])(
  '%s never discovers test files under artifacts/',
  async (_label, args) => {
    const run = await bunTest(args as string[]);
    expect(run.output).not.toContain('stale copy');
    expect(run.output).toContain('1 pass');
    expect(run.code).toBe(0);
  },
  30_000
);
