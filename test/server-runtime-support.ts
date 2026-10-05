/**
 * Helpers for the server-runtime env and timer tests.
 *
 * The runtime reads its env vars once per process, so every env case runs in a fresh
 * Bun process (`process.execPath`) with a sanitized environment: the variables below are
 * removed from the parent's env, then the case's own values are applied. The child body
 * runs inside a try/catch and reports one JSON line: `{ ok: true, ...value }` or
 * `{ ok: false, error }` with the thrown message.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REPO = join(import.meta.dir, '..');

/** Variables a child must not inherit from the developer or CI shell. */
const SANITIZED_ENV = [
  'WORKER_TIMEOUT_MS',
  'WORKER_CLEANUP_INTERVAL_MS',
  'LOCK_TIMEOUT_MS',
  'RATE_LIMIT_WINDOW_MS',
  'RATE_LIMIT_MAX_REQUESTS',
  'RATE_LIMIT_CLEANUP_MS',
  'TCP_IDLE_TIMEOUT_MS',
  'TCP_MAX_WRITE_QUEUE_BYTES',
  'BUNQUEUE_DATA_PATH',
  'BQ_DATA_PATH',
  'DATA_PATH',
  'SQLITE_PATH',
  'BUNQUEUE_EMBEDDED',
  'BUNQUEUE_STORAGE_DRIVER',
  'BUNQUEUE_POSTGRES_URL',
  'TCP_PORT',
  'HTTP_PORT',
  'HOST',
  'AUTH_TOKENS',
  'S3_BACKUP_ENABLED',
  'BUNQUEUE_CLOUD_URL',
];

export function childEnv(env: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SANITIZED_ENV.includes(key)) base[key] = value;
  }
  return { ...base, ...env };
}

export interface ChildResult {
  readonly exitCode: number | null;
  /** stdout followed by stderr. */
  readonly output: string;
  /** The last JSON object line the child printed, if any. */
  readonly report: Record<string, unknown> | null;
}

/** Spawn `argv` with a sanitized env; kill it after `timeoutMs` (exitCode null). */
export async function spawnChild(
  argv: string[],
  env: Record<string, string>,
  timeoutMs = 20_000
): Promise<ChildResult> {
  const child = Bun.spawn(argv, {
    cwd: REPO,
    env: childEnv(env),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exited = await Promise.race([child.exited, Bun.sleep(timeoutMs).then(() => null)]);
  if (exited === null) child.kill(9);
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const line = stdout
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('{'))
    .pop();
  let report: Record<string, unknown> | null = null;
  if (line) {
    try {
      report = JSON.parse(line) as Record<string, unknown>;
    } catch {
      report = null;
    }
  }
  return { exitCode: exited, output: stdout + stderr, report };
}

/**
 * Run `body` (top-level-await TypeScript; `report(value)` prints the result) in a fresh
 * Bun process with `env`. Imports in `body` should use `${REPO}/src/...` paths.
 */
export async function runChild(body: string, env: Record<string, string>): Promise<ChildResult> {
  const dir = mkdtempSync(join(tmpdir(), 'bq-server-runtime-'));
  try {
    const script = join(dir, 'case.ts');
    writeFileSync(
      script,
      [
        'const report = (value: Record<string, unknown>): void => {',
        '  console.log(JSON.stringify({ ok: true, ...value }));',
        '};',
        'try {',
        body,
        '} catch (error) {',
        '  console.log(JSON.stringify({',
        '    ok: false,',
        '    name: error instanceof Error ? error.name : typeof error,',
        '    error: error instanceof Error ? error.message : String(error),',
        '  }));',
        '}',
        'process.exit(0);',
      ].join('\n')
    );
    return await spawnChild([process.execPath, script], env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Matches the warnings Bun prints when a timer delay is out of range. */
export const TIMER_WARNING = /Timeout(Overflow|NaN|Negative)Warning/;
