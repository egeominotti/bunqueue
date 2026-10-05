/**
 * Repro (process level): `bunqueue start` numeric flags warned and continued.
 *
 * - `--completed-retention-ms abc` printed a warning, was ignored, and the server
 *   started with whatever the file or env said;
 * - `--completed-retention-ms` with no value parsed as `true`, and `Number(true)` is 1:
 *   the server started deleting completed jobs after 1 ms;
 * - `--max-completed-jobs 0` and `--tcp-port abc` were ignored with a warning (the
 *   latter fell back to port 6789, which may belong to another server).
 *
 * Now `--completed-retention-ms` with no value and an invalid port flag stop startup
 * with exit code 1 and an error naming the flag. `--completed-retention-ms abc` and
 * `--max-completed-jobs 0` keep 2.9.10's "Warning: ... Ignoring it." and start (upgrade
 * compatibility, see test/repro-compat-config-cli.test.ts); `1e12` is read by `Number`
 * as 10^12, as before.
 */

import { afterAll, expect, test } from 'bun:test';
import { makeSandbox, runServer, type Sandbox } from './config-test-support';

const sandboxes: Sandbox[] = [];
afterAll(() => {
  for (const sandbox of sandboxes) sandbox.cleanup();
});

const CASES: Array<{ args: string[]; message: string }> = [
  {
    args: ['--completed-retention-ms'],
    message: 'Invalid --completed-retention-ms: missing value',
  },
  // `abc` / `70000` warn and use the default port, as 2.9.10 did (unit-tested in
  // test/repro-compat-config-review.test.ts, so no server binds 6789 here); misreads stop.
  { args: ['--tcp-port', '1e4'], message: 'Invalid --tcp-port: "1e4"' },
  { args: ['--http-port', '6790abc'], message: 'Invalid --http-port: "6790abc"' },
];

const IGNORED: Array<{ args: string[]; message: string }> = [
  {
    args: ['--completed-retention-ms', 'abc'],
    message: 'Warning: Invalid completed-job retention "abc"',
  },
  {
    args: ['--max-completed-jobs', '0'],
    message: 'Warning: Invalid completed-job cache limit "0"',
  },
];

test('an invalid numeric flag stops `bunqueue start` with an error naming the flag', async () => {
  const results = await Promise.all(
    CASES.map(async ({ args, message }) => {
      const sandbox = makeSandbox('bunqueue-cli-flags-');
      sandboxes.push(sandbox);
      const run = await runServer(sandbox, { args: ['start', ...args], killAfterMs: 4_000 });
      return { args, exitCode: run.exitCode, named: run.output.includes(message) };
    })
  );
  expect(results).toEqual(results.map(({ args }) => ({ args, exitCode: 1, named: true })));
}, 20_000);

test('an invalid storage flag is ignored with a warning, as in 2.9.10', async () => {
  const results = await Promise.all(
    IGNORED.map(async ({ args, message }) => {
      const sandbox = makeSandbox('bunqueue-cli-flags-');
      sandboxes.push(sandbox);
      const run = await runServer(sandbox, {
        args: ['start', ...args],
        killAfterMs: 6_000,
        killWhen: /Shards/,
      });
      return { args, exitCode: run.exitCode, named: run.output.includes(message) };
    })
  );
  expect(results).toEqual(results.map(({ args }) => ({ args, exitCode: null, named: true })));
}, 20_000);
