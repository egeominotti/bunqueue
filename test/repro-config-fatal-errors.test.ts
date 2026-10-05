/**
 * Repro (process level): `src/main.ts` — the entry point of `bun src/main.ts` and of the
 * compiled Docker binary — reported a configuration error as an uncaught exception: a
 * source code frame, a stack trace and the Bun version banner around the message.
 *
 * Every configuration error must now print exactly `Fatal error: <message>` on stderr
 * (or `{ ok: false, error }` with --json) and exit 1, whether it comes from an env var,
 * the config file or a flag, through the bare server or through `start`. A real crash
 * (here: a config module that throws while it is imported) must stay fully visible.
 *
 * Also covered here, end to end: `--port abc` on a client command used to start silently
 * (a warning, then port 6789) and is now an error. Inputs 2.9.10 ran with keep running
 * (upgrade compatibility): `S3_BACKUP_ENABLED=1` with no bucket or credentials logs
 * "S3 backup configuration invalid" naming the missing settings and serves without
 * backups; `S3_BACKUP_ENABLED=yes` now means true (it was read as false), so the same
 * log line appears; an unknown `METRICS_AUTH` word is a warning.
 */

import { afterAll, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { makeSandbox, runServer, type Sandbox } from './config-test-support';

const sandboxes: Sandbox[] = [];
afterAll(() => {
  for (const sandbox of sandboxes) sandbox.cleanup();
});

function sandbox(files: Record<string, string> = {}): Sandbox {
  const created = makeSandbox('bunqueue-fatal-');
  for (const [name, contents] of Object.entries(files)) created.writeFile(name, contents);
  sandboxes.push(created);
  return created;
}

/** Long enough for a fixed process to exit, short enough to bound one that keeps running. */
const KILL_AFTER_MS = 4_000;

interface Case {
  readonly label: string;
  readonly env?: Record<string, string>;
  readonly args?: string[];
  readonly files?: Record<string, string>;
  /** The whole expected output (trimmed); `<dir>` stands for the sandbox directory. */
  readonly output: string;
}

const CASES: Case[] = [
  {
    label: 'unsupported storage driver (bare server)',
    env: { BUNQUEUE_STORAGE_DRIVER: 'foo' },
    output:
      'Fatal error: Unsupported storage driver: foo (BUNQUEUE_STORAGE_DRIVER; expected memory, sqlite or postgres)',
  },
  {
    label: 'invalid env number (bare server)',
    env: { STATS_INTERVAL_MS: 'abc' },
    output:
      'Fatal error: Invalid STATS_INTERVAL_MS: "abc" (expected a whole number of milliseconds >= 1)',
  },
  {
    label: 'invalid server flag (start)',
    // `abc` warns and uses 6789, as 2.9.10 did; a misread (parseInt: port 1) still stops.
    args: ['start', '--tcp-port', '1e4'],
    output: 'Fatal error: Invalid --tcp-port: "1e4" (expected a whole number between 0 and 65535)',
  },
  {
    label: 'invalid global --port (client command)',
    args: ['--port', 'abc', 'stats'],
    output: 'Fatal error: Invalid --port: "abc" (expected a whole number between 1 and 65535)',
  },
  {
    label: 'missing explicit config file',
    args: ['start', '--config', 'missing.config.ts'],
    output: 'Fatal error: Config file not found: <dir>/missing.config.ts',
  },
  {
    label: 'invalid config-file value',
    files: { 'bunqueue.config.ts': 'export default { timeouts: { stats: 0 } };\n' },
    output: 'Fatal error: timeouts.stats must be a finite number of milliseconds >= 1 (got 0)',
  },
];

/** Inputs 2.9.10 ran with: the server keeps running and logs what it ignores. */
const RUNS: Array<{ label: string; env: Record<string, string>; expected: RegExp }> = [
  {
    label: 'S3 backup enabled without bucket or credentials',
    env: { S3_BACKUP_ENABLED: '1' },
    expected: /S3 backup configuration invalid.*S3_BUCKET.*S3_ACCESS_KEY_ID.*S3_SECRET_ACCESS_KEY/,
  },
  {
    label: 'S3_BACKUP_ENABLED=yes is a boolean, not false',
    env: { S3_BACKUP_ENABLED: 'yes', S3_BUCKET: 'bucket' },
    expected: /S3 backup configuration invalid.*S3_ACCESS_KEY_ID/,
  },
  {
    label: 'unknown boolean word',
    env: { METRICS_AUTH: 'enabled' },
    expected: /Invalid METRICS_AUTH: \\"enabled\\".*using false/,
  },
];

test('inputs 2.9.10 ran with keep the server running, with an error or warning line', async () => {
  const results = await Promise.all(
    RUNS.map(async ({ label, env, expected }) => {
      const run = await runServer(sandbox(), { env, killAfterMs: KILL_AFTER_MS });
      return { label, exitCode: run.exitCode, logged: expected.test(run.output) };
    })
  );
  // Killed at the deadline (exit code null): the server was still running.
  expect(results).toEqual(results.map(({ label }) => ({ label, exitCode: null, logged: true })));
}, 30_000);

test('a configuration error prints one clean "Fatal error:" message and exits 1', async () => {
  const results = await Promise.all(
    CASES.map(async ({ label, env, args, files, output }) => {
      const box = sandbox(files);
      const run = await runServer(box, { env, args, killAfterMs: KILL_AFTER_MS });
      return {
        label,
        exitCode: run.exitCode,
        // The child sees the resolved temp dir (/private/var/... on macOS).
        output: run.output
          .trim()
          .replaceAll(realpathSync(box.dir), '<dir>')
          .replaceAll(box.dir, '<dir>'),
        expected: output,
      };
    })
  );
  expect(results.map(({ label, exitCode, output }) => ({ label, exitCode, output }))).toEqual(
    results.map(({ label, expected }) => ({ label, exitCode: 1, output: expected }))
  );
}, 30_000);

test('several problems are listed in one message, still without a stack', async () => {
  const run = await runServer(sandbox(), {
    env: { STATS_INTERVAL_MS: '0', SHUTDOWN_TIMEOUT_MS: 'abc' },
    killAfterMs: KILL_AFTER_MS,
  });
  expect({ exitCode: run.exitCode, output: run.output.trim() }).toEqual({
    exitCode: 1,
    output: [
      'Fatal error: Invalid server configuration:',
      '  - Invalid SHUTDOWN_TIMEOUT_MS: "abc" (expected a whole number of milliseconds >= 0)',
      '  - Invalid STATS_INTERVAL_MS: "0" (expected a whole number of milliseconds >= 1)',
    ].join('\n'),
  });
}, 15_000);

test('--json prints the error as one JSON document', async () => {
  const run = await runServer(sandbox(), {
    args: ['start', '--tcp-port', '1e4', '--json'],
    killAfterMs: KILL_AFTER_MS,
  });
  expect(run.exitCode).toBe(1);
  expect(JSON.parse(run.output)).toEqual({
    ok: false,
    error: 'Invalid --tcp-port: "1e4" (expected a whole number between 0 and 65535)',
  });
}, 15_000);

test('a real crash stays visible with its stack', async () => {
  const box = sandbox({
    'bunqueue.config.ts': "throw new Error('config module exploded');\nexport default {};\n",
  });
  const run = await runServer(box, { killAfterMs: KILL_AFTER_MS });
  expect(run.exitCode).toBe(1);
  expect(run.output).toContain('config module exploded');
  expect(run.output).toMatch(/\n\s+at .+bunqueue\.config\.ts/);
  expect(run.output).not.toContain('Fatal error:');
}, 15_000);
