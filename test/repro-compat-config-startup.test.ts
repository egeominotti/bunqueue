/**
 * Repro (upgrade compatibility, process level): deployments that ran on 2.9.10 and did
 * what the operator meant, started with the 2.9.11 candidate.
 *
 * - Auth lockout: `AUTH_TOKENS=$'s3cret\n'` (a secret file with a trailing newline) and
 *   clients sending the same `"s3cret\n"` authenticated on 2.9.10. The candidate trims
 *   the configured token but compared the presented TCP token raw: every client failed.
 * - S3 backup enabled without a bucket: 2.9.10 logged "S3 backup configuration invalid"
 *   and served without backups; the candidate refused to start.
 * - Logging precedence: with the bare entry (`src/main.ts`, the Docker image),
 *   LOG_FORMAT=json kept JSON even when the file said `text`; LOG_LEVEL=WARNING was
 *   ignored instead of stopping startup.
 * - `tcpPort: process.env.PORT` (a string), STATS_INTERVAL_MS=500, `timeouts.lock: 5`
 *   (documented as ignored) all started.
 * - Embedded mode: MEMORY_WARNING_MB=-1 made the first `Queue` throw.
 */

import { afterAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Queue } from '../src/client';
import {
  REPO,
  freePort,
  makeSandbox,
  runChild,
  runServer,
  statsLines,
  type Sandbox,
} from './config-test-support';

const sandboxes: Sandbox[] = [];
afterAll(() => {
  for (const sandbox of sandboxes) sandbox.cleanup();
});

function sandbox(config?: unknown): Sandbox {
  const created = makeSandbox('bunqueue-compat-start-');
  sandboxes.push(created);
  if (config !== undefined) created.writeConfig(config);
  return created;
}

const READY = /One queue\. Any language\.[\s\S]*Shards/;

/** Spawn the server and resolve once its banner is out; `stop()` kills it. */
async function startServer(box: Sandbox, env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, join(REPO, 'src', 'main.ts')], {
    cwd: box.dir,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      BUNQUEUE_DATA_PATH: box.dataPath,
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  const deadline = Date.now() + 8_000;
  while (!READY.test(output) && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  await Bun.sleep(200);
  return { ready: READY.test(output), stop: () => proc.kill('SIGKILL') };
}

test('a token with a trailing newline still authenticates TCP and HTTP clients', async () => {
  const [tcpPort, httpPort] = [freePort(), freePort()];
  const server = await startServer(sandbox(), {
    HOST: '127.0.0.1',
    TCP_PORT: String(tcpPort),
    HTTP_PORT: String(httpPort),
    AUTH_TOKENS: 's3cret\n',
  });
  // `embedded: false`: the test preload forces embedded mode otherwise. The public
  // options have no "never reconnect" switch, so a refused Auth (the client keeps
  // retrying) is bounded by the race below instead.
  const queue = new Queue('compat-auth', {
    embedded: false,
    connection: { host: '127.0.0.1', port: tcpPort, token: 's3cret\n', commandTimeout: 3_000 },
    autoBatch: { enabled: false },
  });
  try {
    expect(server.ready).toBe(true);
    const added = await Promise.race([
      queue.add('x', { a: 1 }).then(
        (job) => typeof job.id === 'string',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      ),
      Bun.sleep(5_000).then(() => 'timed out: the client never authenticated'),
    ]);
    expect(added).toBe(true);
    const response = await fetch(`http://127.0.0.1:${httpPort}/stats`, {
      headers: { Authorization: 'Bearer s3cret' },
    });
    expect(response.status).toBe(200);
  } finally {
    await Promise.race([queue.close(), Bun.sleep(1_000)]);
    server.stop();
  }
}, 20_000);

test('deployments that ran on 2.9.10 still start', async () => {
  const port = freePort();
  const cases: Array<{
    label: string;
    box: Sandbox;
    env?: Record<string, string>;
    expect: RegExp;
  }> = [
    {
      label: 'S3 backup enabled without bucket',
      box: sandbox(),
      env: { S3_BACKUP_ENABLED: 'true' },
      expect: /S3 backup configuration invalid[\s\S]*S3_BUCKET/,
    },
    {
      label: 'tcpPort from process.env.PORT (a string)',
      box: sandbox(),
      env: { PORT: String(port) },
      expect: new RegExp(`127\\.0\\.0\\.1:${port}`),
    },
    {
      label: 'timeouts.lock: 5 is ignored with a warning',
      box: sandbox({ timeouts: { lock: 5 } }),
      expect: /timeouts\.lock[^\n]*LOCK_TIMEOUT_MS/,
    },
    { label: 'LOG_LEVEL=WARNING', box: sandbox(), env: { LOG_LEVEL: 'WARNING' }, expect: /Shards/ },
  ];
  cases[1].box.writeFile(
    'bunqueue.config.ts',
    'export default { server: { tcpPort: process.env.PORT } };\n'
  );
  const results = await Promise.all(
    cases.map(async (c) => {
      // Wait for the banner and the expected line, in any order.
      const both = new RegExp(`^(?=[\\s\\S]*${READY.source})(?=[\\s\\S]*${c.expect.source})`);
      const run = await runServer(c.box, { env: c.env, killAfterMs: 6_000, killWhen: both });
      return { label: c.label, exitCode: run.exitCode, seen: c.expect.test(run.output) };
    })
  );
  expect(results).toEqual(results.map(({ label }) => ({ label, exitCode: null, seen: true })));
}, 30_000);

test('STATS_INTERVAL_MS=500 logs stats twice a second', async () => {
  const run = await runServer(sandbox(), { env: { STATS_INTERVAL_MS: '500' }, killAfterMs: 3_500 });
  expect(run.exitCode).toBeNull();
  expect(statsLines(run.output)).toBeGreaterThanOrEqual(2);
}, 20_000);

test('LOG_FORMAT=json survives logging.format: text on the bare entry, as on 2.9.10', async () => {
  // The unknown key makes the server log one warning, in the active format.
  const run = await runServer(sandbox({ logging: { format: 'text' }, unknownSection: {} }), {
    env: { LOG_FORMAT: 'json' },
    killAfterMs: 6_000,
    killWhen: READY,
  });
  expect(run.output).toMatch(/^\{"timestamp"/m);
}, 20_000);

test('embedded mode reads -1 thresholds as disabled', async () => {
  const box = sandbox();
  const script = box.writeFile(
    'embedded.ts',
    `
const { Queue } = await import(${JSON.stringify(join(REPO, 'src/client/index.ts'))});
const queue = new Queue('compat-embedded', { embedded: true });
const job = await queue.add('x', { a: 1 });
console.log(JSON.stringify({ ok: typeof job.id === 'string' }));
await queue.close();
process.exit(0);
`
  );
  const run = await runChild([script], {
    cwd: box.dir,
    env: {
      MEMORY_WARNING_MB: '-1',
      STORAGE_WARNING_MB: '-1',
      QUEUE_IDLE_THRESHOLD_MS: '-1',
      QUEUE_SIZE_THRESHOLD: '-1',
      WORKER_OVERLOAD_THRESHOLD_MS: '-1',
    },
    killAfterMs: 10_000,
  });
  expect(run.output).toContain('{"ok":true}');
}, 20_000);
