#!/usr/bin/env bun
/**
 * Run the maintained MCP regression suites, including expected errors and
 * independently asserted state changes. Extra arguments are forwarded to bun test.
 *
 * Run: bun scripts/test-mcp-all.ts [-t <test-name-pattern>]
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const files = readdirSync(join(root, 'test'))
  .filter((name) => name.endsWith('.test.ts') && /(?:^|-)mcp(?:[.-]|$)/.test(name))
  .sort()
  .map((name) => join('test', name));

if (files.length === 0) throw new Error('No MCP regression suites found');
console.log(`Running ${files.length} MCP regression suites; outcomes are verified by assertions.`);

// Tests own their broker/database/provider settings; never inherit a caller's target.
const env: Record<string, string> = {
  BUNQUEUE_EMBEDDED: '1',
  NODE_ENV: 'test',
  // Maintained suites launch real Bun executables; their descendants must also skip .env.
  BUN_OPTIONS: '--no-env-file',
};
for (const key of [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'CI',
  'TERM',
  'TZ',
  'LANG',
  'LC_ALL',
  'FORCE_COLOR',
  'NO_COLOR',
]) {
  const value = process.env[key];
  if (value !== undefined) env[key] = value;
}

const child = Bun.spawn(
  [process.execPath, '--no-env-file', 'test', '--parallel=4', ...files, ...process.argv.slice(2)],
  {
    cwd: root,
    env,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  }
);
const interrupt = () => child.kill('SIGINT');
const terminate = () => child.kill('SIGTERM');
process.once('SIGINT', interrupt);
process.once('SIGTERM', terminate);
try {
  process.exitCode = await child.exited;
} finally {
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', terminate);
}
