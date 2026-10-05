/**
 * Repro (upgrade compatibility, CLI): command lines that worked on 2.9.10 stopped the
 * 2.9.11 candidate.
 *
 * - Client commands under Kubernetes: a Service named `bunqueue-tcp` injects
 *   `BUNQUEUE_TCP_PORT=tcp://10.96.0.12:6789`. 2.9.10 warned and used 6789; the
 *   candidate refused every client command. An empty TCP_PORT shadowed the aliases.
 * - Empty flag values (`--tcp-port=`, `--http-port=`, `--host=`, `--config=`, client
 *   `--port=` / `--host=`) meant "not given" (env or default).
 * - `--tcp-port 50615.0`, `-p 6789.0`, `+6789` were read by `parseInt`;
 *   `--max-completed-jobs 1e5` by `Number`.
 * - `--completed-retention-ms -1` and `--max-completed-jobs 0` printed
 *   "Warning: Invalid ... Ignoring it." and the server started.
 *
 * Kept: `--auth-tokens ""` and `--data-path ""` stop startup; `-p 0` and `--port=abc`
 * on a client command are errors.
 */

import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { parseGlobalOptions } from '../src/cli/globalOptions';
import {
  freePort,
  makeSandbox,
  outcome,
  runServer,
  withEnv,
  type Sandbox,
} from './config-test-support';

const env = withEnv();
afterEach(() => env.restore());

const CLEAR = { TCP_PORT: undefined, BUNQUEUE_TCP_PORT: undefined, BQ_TCP_PORT: undefined };

function parse(args: string[], vars: Record<string, string | undefined> = {}) {
  env.set({ ...CLEAR, HOST: undefined, BUNQUEUE_HOST: undefined, BQ_HOST: undefined, ...vars });
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return {
      result: outcome(() => parseGlobalOptions(args)),
      warnings: warn.mock.calls.map(String),
    };
  } finally {
    warn.mockRestore();
  }
}

describe('client commands', () => {
  test('an invalid env port warns and uses 6789 (Kubernetes service links)', () => {
    const { result, warnings } = parse(['stats'], { BUNQUEUE_TCP_PORT: 'tcp://10.96.0.12:6789' });
    expect(result).toMatchObject({ value: { options: { port: 6789 } } });
    expect(warnings.some((w) => w.includes('tcp://10.96.0.12:6789'))).toBe(true);
  });

  test('an empty TCP_PORT shadows BUNQUEUE_TCP_PORT (2.9.10 resolved them with ??)', () => {
    expect(parse(['stats'], { TCP_PORT: '', BUNQUEUE_TCP_PORT: '7000' }).result).toMatchObject({
      value: { options: { port: 6789 } },
    });
    expect(parse(['stats'], { BUNQUEUE_TCP_PORT: '6790.0' }).result).toMatchObject({
      value: { options: { port: 6790 } },
    });
  });

  test('-p 6789.0 and --port=+7001 are read as written', () => {
    expect(parse(['-p', '6789.0', 'stats']).result).toMatchObject({
      value: { options: { port: 6789 } },
    });
    expect(parse(['--port=+7001', 'stats']).result).toMatchObject({
      value: { options: { port: 7001 } },
    });
  });

  test('--port= and --host= mean "not given"', () => {
    const { result } = parse(['--port=', '--host=', 'stats'], {
      TCP_PORT: '7002',
      HOST: 'queue.local',
    });
    expect(result).toMatchObject({ value: { options: { port: 7002, host: 'queue.local' } } });
  });

  test('-p 0 and --port=abc stay errors on a client command', () => {
    expect(parse(['-p', '0', 'stats']).result).toEqual({ error: expect.stringContaining('-p') });
    expect(parse(['--port=abc', 'stats']).result).toEqual({
      error: expect.stringContaining('--port'),
    });
  });
});

const sandboxes: Sandbox[] = [];
afterAll(() => {
  for (const sandbox of sandboxes) sandbox.cleanup();
});

function sandbox(): Sandbox {
  const created = makeSandbox('bunqueue-compat-cli-');
  sandboxes.push(created);
  return created;
}

const READY = /One queue\. Any language\.[\s\S]*Shards/;

test('server flags 2.9.10 accepted start the server', async () => {
  const [tcp, http, fileTcp, flagTcp] = [freePort(), freePort(), freePort(), freePort()];
  const configured = sandbox();
  configured.writeConfig({ server: { tcpPort: fileTcp } });
  const cases: Array<{
    label: string;
    box: Sandbox;
    args: string[];
    env?: Record<string, string>;
    expect: string;
  }> = [
    {
      label: 'empty --tcp-port= / --http-port= / --host= use the env',
      box: sandbox(),
      args: ['start', '--tcp-port=', '--http-port=', '--host='],
      env: { TCP_PORT: String(tcp), HTTP_PORT: String(http) },
      expect: `127.0.0.1:${tcp}`,
    },
    {
      label: 'empty --config= auto-discovers bunqueue.config.ts',
      box: configured,
      args: ['start', '--config='],
      expect: `127.0.0.1:${fileTcp}`,
    },
    {
      label: '--tcp-port 50615.0',
      box: sandbox(),
      args: ['start', '--tcp-port', `${flagTcp}.0`],
      expect: `127.0.0.1:${flagTcp}`,
    },
    {
      label: '--max-completed-jobs 1e5',
      box: sandbox(),
      args: ['start', '--max-completed-jobs', '1e5'],
      expect: 'Shards',
    },
    {
      label: '--completed-retention-ms -1',
      box: sandbox(),
      args: ['start', '--completed-retention-ms', '-1'],
      expect: 'Ignoring it',
    },
    {
      label: '--max-completed-jobs 0',
      box: sandbox(),
      args: ['start', '--max-completed-jobs', '0'],
      expect: 'Ignoring it',
    },
  ];
  const results = await Promise.all(
    cases.map(async (c) => {
      const run = await runServer(c.box, {
        args: c.args,
        env: c.env,
        killAfterMs: 6_000,
        killWhen: READY,
      });
      return {
        label: c.label,
        fatal: run.output.includes('Fatal error'),
        seen: run.output.includes(c.expect),
      };
    })
  );
  expect(results).toEqual(results.map(({ label }) => ({ label, fatal: false, seen: true })));
}, 30_000);

test('--auth-tokens "" and --data-path "" still stop startup', async () => {
  const results = await Promise.all(
    [
      ['--auth-tokens', ''],
      ['--data-path', ''],
    ].map(async (args) => {
      const run = await runServer(sandbox(), { args: ['start', ...args], killAfterMs: 5_000 });
      return { args, exitCode: run.exitCode };
    })
  );
  expect(results).toEqual(results.map(({ args }) => ({ args, exitCode: 1 })));
}, 20_000);
