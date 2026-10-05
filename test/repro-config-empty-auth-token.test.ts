/**
 * Repro (security): an empty auth token authenticated every unauthenticated request.
 *
 * - A config file with `auth: { tokens: [''] }` was accepted. It type-checks, and it is
 *   what `tokens: [process.env.API_TOKEN ?? '']` produces when the variable is unset.
 *   The HTTP server reads a missing `Authorization` header as `''`, which matched the
 *   empty token, so every request without credentials was authenticated. A TCP or
 *   WebSocket client could send `{ cmd: 'Auth', token: '' }` (or a non-string token)
 *   and be authenticated the same way. Whitespace-only tokens (`'  '`) worked likewise.
 * - `AUTH_TOKENS` was split on commas without trimming: `AUTH_TOKENS=" "` configured
 *   the token `" "`, `AUTH_TOKENS="a, ,b"` added `" "` next to the real tokens, and
 *   `AUTH_TOKENS=","` produced no token at all, so auth was silently disabled although
 *   the operator had set the variable.
 * - `bunqueue start --auth-tokens` had the same untrimmed split, and its result
 *   replaces `AUTH_TOKENS`: `--auth-tokens ,` started the server with auth disabled even
 *   with `AUTH_TOKENS` set, and `--auth-tokens 'a, b'` configured the token `" b"`.
 *
 * Now an empty or whitespace-only token in the config file stops startup naming the
 * key; `AUTH_TOKENS` entries are trimmed and empty entries dropped, and a set,
 * non-empty value that yields no token stops startup (the flag follows the same rule
 * and its errors name `--auth-tokens`); and both auth checks (HTTP and
 * the TCP/WebSocket `Auth` command) refuse an empty presented token even if an empty
 * token reached the configured set.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { resolveServerConfig } from '../src/config/resolve';
import type { BunqueueConfig } from '../src/config/types';
import type { Command } from '../src/domain/types/command';
import { handleCommand } from '../src/infrastructure/server/handler';
import { createHttpServer, type HttpServer } from '../src/infrastructure/server/http';
import type { HandlerContext } from '../src/infrastructure/server/types';
import {
  MAIN,
  freePort,
  makeSandbox,
  outcome,
  runServer,
  type Sandbox,
} from './config-test-support';

/** Long enough for a refused startup to exit, short enough to bound a server that runs. */
const KILL_AFTER_MS = 4_000;

const sandboxes: Sandbox[] = [];
afterAll(() => {
  for (const sandbox of sandboxes) sandbox.cleanup();
});

function sandbox(): Sandbox {
  const created = makeSandbox('bunqueue-empty-token-');
  sandboxes.push(created);
  return created;
}

function resolveFile(file: unknown, env: Record<string, string | undefined> = {}) {
  return outcome(() => resolveServerConfig(file as BunqueueConfig, env));
}

const blankTokenError = (index: number, raw: string) =>
  `auth.tokens[${index}] must not be empty or whitespace-only (got ${JSON.stringify(raw)})`;

const tokenListError = (name: string, raw: string) =>
  `Invalid ${name}: ${JSON.stringify(raw)} (expected a comma-separated list of non-empty tokens)`;
const authTokensEnvError = (raw: string) => tokenListError('AUTH_TOKENS', raw);

/** Run the real server and expect it to refuse to start with exactly `message`. */
async function expectRefusal(
  box: Sandbox,
  options: { env?: Record<string, string>; args?: string[] },
  message: string
): Promise<void> {
  const run = await runServer(box, { ...options, killAfterMs: KILL_AFTER_MS });
  expect({ exitCode: run.exitCode, output: run.output.trim() }).toEqual({
    exitCode: 1,
    output: `Fatal error: ${message}`,
  });
}

/** Start the real server with `args`, run `probe` against its HTTP API, then kill it. */
async function withRunningServer<T>(args: string[], probe: (base: string) => Promise<T>) {
  const box = sandbox();
  const httpPort = freePort();
  const inherited = ['PATH', 'HOME', 'TMPDIR', 'LANG'].flatMap((key) => {
    const value = process.env[key];
    return value === undefined ? [] : [[key, value] as const];
  });
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    cwd: box.dir,
    env: {
      ...Object.fromEntries(inherited),
      HOST: '127.0.0.1',
      TCP_PORT: String(freePort()),
      HTTP_PORT: String(httpPort),
      BUNQUEUE_DATA_PATH: box.dataPath,
      LOG_FORMAT: 'json',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const base = `http://127.0.0.1:${httpPort}`;
  try {
    const deadline = Date.now() + 10_000;
    const up = () =>
      fetch(`${base}/health`).then(
        (res) => res.ok,
        () => false
      );
    while (!(await up())) {
      if (proc.exitCode !== null || Date.now() > deadline) throw new Error('server did not start');
      await Bun.sleep(50);
    }
    return await probe(base);
  } finally {
    proc.kill('SIGKILL');
    await proc.exited;
  }
}

describe('config file: an empty or whitespace-only token stops startup', () => {
  test('the real server refuses `tokens: [process.env.API_TOKEN ?? ""]` with API_TOKEN unset', async () => {
    const box = sandbox();
    box.writeFile(
      'bunqueue.config.ts',
      "export default { auth: { tokens: [process.env.API_TOKEN ?? ''] } };\n"
    );
    await expectRefusal(box, {}, blankTokenError(0, ''));
  }, 15_000);

  test('the real server refuses a whitespace-only token', async () => {
    const box = sandbox();
    box.writeConfig({ auth: { tokens: ['   '] } });
    await expectRefusal(box, {}, blankTokenError(0, '   '));
  }, 15_000);

  test.each([
    ['empty', [''], [blankTokenError(0, '')]],
    ['spaces', ['   '], [blankTokenError(0, '   ')]],
    ['tab and newline', ['\t\n'], [blankTokenError(0, '\t\n')]],
    ['empty next to a valid token', ['secret', ''], [blankTokenError(1, '')]],
  ])('rejects an %s token, naming the entry', (_label, tokens, problems) => {
    expect(resolveFile({ auth: { tokens } })).toEqual({ error: problems.join('\n') });
  });

  test('reports every blank entry at once', () => {
    expect(resolveFile({ auth: { tokens: ['', 'secret', ' '] } })).toEqual({
      error: [
        'Invalid server configuration:',
        `  - ${blankTokenError(0, '')}`,
        `  - ${blankTokenError(2, ' ')}`,
      ].join('\n'),
    });
  });

  test('valid tokens are unchanged, and an explicit empty list still means no auth', () => {
    expect(resolveFile({ auth: { tokens: ['secret', 'other-secret'] } })).toEqual({
      value: expect.objectContaining({ authTokens: ['secret', 'other-secret'] }),
    });
    expect(resolveFile({ auth: { tokens: [] } })).toEqual({
      value: expect.objectContaining({ authTokens: [] }),
    });
  });
});

describe('AUTH_TOKENS: entries are trimmed, empty entries dropped, no token at all is an error', () => {
  test.each([
    ['token1,token2,,token3', ['token1', 'token2', 'token3']],
    ['a,', ['a']],
    [',a', ['a']],
    [' a , b ', ['a', 'b']],
    ['a, ,b', ['a', 'b']],
    ['a,\t,b', ['a', 'b']],
    ['', []],
    [undefined, []],
  ])('AUTH_TOKENS=%j resolves to %j', (raw, tokens) => {
    expect(resolveFile(null, { AUTH_TOKENS: raw })).toEqual({
      value: expect.objectContaining({ authTokens: tokens }),
    });
  });

  test.each([',', ',,', ' ', '\t', ' , '])('AUTH_TOKENS=%j stops startup', (raw) => {
    expect(resolveFile(null, { AUTH_TOKENS: raw })).toEqual({ error: authTokensEnvError(raw) });
  });

  test('the config file still wins over AUTH_TOKENS', () => {
    expect(resolveFile({ auth: { tokens: ['file-token'] } }, { AUTH_TOKENS: 'env-token' })).toEqual(
      { value: expect.objectContaining({ authTokens: ['file-token'] }) }
    );
  });

  test('the real server refuses AUTH_TOKENS=","', async () => {
    await expectRefusal(sandbox(), { env: { AUTH_TOKENS: ',' } }, authTokensEnvError(','));
  }, 15_000);
});

describe('bunqueue start --auth-tokens: the AUTH_TOKENS rule, errors name the flag', () => {
  test.each([
    [',', { AUTH_TOKENS: 'env-secret' }],
    [' , ', {}],
  ])(
    '--auth-tokens %j refuses to start (env %j)',
    async (raw, env) => {
      const args = ['start', '--auth-tokens', raw];
      await expectRefusal(sandbox(), { args, env }, tokenListError('--auth-tokens', raw));
    },
    15_000
  );

  test("--auth-tokens 'a, b' configures the trimmed tokens a and b", async () => {
    const statuses = await withRunningServer(['start', '--auth-tokens', 'a, b'], (base) =>
      Promise.all(
        [undefined, 'Bearer a', 'Bearer b'].map(async (authorization) => {
          const headers = authorization === undefined ? {} : { Authorization: authorization };
          return (await fetch(`${base}/stats`, { headers })).status;
        })
      )
    );
    expect(statuses).toEqual([401, 200, 200]);
  }, 20_000);
});

describe('defense in depth: an empty token in the set never authenticates', () => {
  let qm: QueueManager;
  let http: HttpServer | null = null;

  beforeEach(() => {
    qm = new QueueManager();
  });

  afterEach(() => {
    http?.stop();
    http = null;
    qm.shutdown();
  });

  function startHttp(authTokens: string[]): string {
    http = createHttpServer(qm, { hostname: '127.0.0.1', port: 0, authTokens });
    return `http://127.0.0.1:${http.server.port}`;
  }

  test.each([
    ['no Authorization header', {}],
    ['an empty Authorization header', { Authorization: '' }],
    ['an empty bearer token', { Authorization: 'Bearer ' }],
  ])('HTTP rejects %s against the token set [""]', async (_label, headers) => {
    const base = startHttp(['']);
    const stats = await fetch(`${base}/stats`, { headers });
    const gc = await fetch(`${base}/gc`, { method: 'POST', headers });
    expect([stats.status, gc.status]).toEqual([401, 401]);
  });

  test('HTTP still accepts a valid token next to an empty one', async () => {
    const base = startHttp(['secret', '']);
    const anonymous = await fetch(`${base}/stats`);
    const authorized = await fetch(`${base}/stats`, {
      headers: { Authorization: 'Bearer secret' },
    });
    expect([anonymous.status, authorized.status]).toEqual([401, 200]);
  });

  function tcpContext(tokens: string[]): HandlerContext {
    return {
      queueManager: qm,
      authTokens: new Set(tokens),
      authenticated: false,
      clientId: 'repro-empty-token',
    };
  }

  test.each([
    ['""', [''], ''],
    ['"  "', ['  '], '  '],
    ['a number', [''], 5],
    ['an empty array', [''], []],
  ])('the TCP/WebSocket Auth command rejects %s', async (_label, tokens, token) => {
    const ctx = tcpContext(tokens);
    const auth = await handleCommand({ cmd: 'Auth', token } as unknown as Command, ctx);
    const stats = await handleCommand({ cmd: 'Stats' } as Command, ctx);
    expect({ auth, authenticated: ctx.authenticated, stats }).toEqual({
      auth: expect.objectContaining({ ok: false, error: 'Invalid token' }),
      authenticated: false,
      stats: expect.objectContaining({ ok: false, error: 'Not authenticated' }),
    });
  });

  test('the TCP Auth command still accepts a valid token next to an empty one', async () => {
    const ctx = tcpContext(['secret', '']);
    const auth = await handleCommand({ cmd: 'Auth', token: 'secret' } as Command, ctx);
    expect({ ok: auth.ok, authenticated: ctx.authenticated }).toEqual({
      ok: true,
      authenticated: true,
    });
  });
});
