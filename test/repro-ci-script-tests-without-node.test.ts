/**
 * Regression: the tests that run CI's version-gate bash must pass without Node.
 *
 * The gate's first command is `node -p`. GitHub's runners have Node and the
 * sandbox image (oven/bun) ships a node->bun fallback, but the Bun-only OrbStack
 * Machines (docs/testing.md) have no `node`, and there six of these tests failed
 * with `node: command not found` (the Machine gate's former "known node gap").
 * Each file now links a `node` to the running Bun first on the gate's PATH.
 *
 * "Node absent" is simulated with a `node` first on PATH that behaves like a
 * missing command (exit 127): removing directories from PATH is not portable,
 * because `node` can share one with `bash` or `awk`.
 */
import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = `${import.meta.dir}/..`;
const FILES = [
  'test/repro-docker-version-gate-errors.test.ts',
  'test/repro-release-source-commit.test.ts',
];
const shadow = mkdtempSync(join(tmpdir(), 'bunqueue-no-node-'));
afterAll(() => rmSync(shadow, { recursive: true, force: true }));
writeFileSync(
  join(shadow, 'node'),
  '#!/bin/sh\necho "bash: node: command not found" >&2\nexit 127\n'
);
chmodSync(join(shadow, 'node'), 0o755);
const PATH = `${shadow}:${process.env.PATH ?? ''}`;

async function spawn(cmd: string[]) {
  const child = Bun.spawn(cmd, {
    cwd: root,
    env: { ...process.env, PATH },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: stdout + stderr };
}

test('the simulated environment has no usable node', async () => {
  const probe = await spawn(['bash', '-c', 'node -p 1']);
  expect(probe.code).toBe(127);
});

test('the version-gate tests pass when node is absent from PATH', async () => {
  const run = await spawn([process.execPath, 'test', ...FILES]);
  expect(
    { code: run.code, missingNode: run.output.includes('node: command not found') },
    run.output
  ).toEqual({ code: 0, missingNode: false });
  expect(run.output).toMatch(/^\s*0 fail$/m);
  expect(run.output).not.toMatch(/^\s*\d+ skip$/m);
  expect(run.output).toMatch(/^Ran \d+ tests across 2 files\./m);
}, 60_000);
