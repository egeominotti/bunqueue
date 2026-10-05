/**
 * Repro (process level): `src/main.ts` started with invalid settings.
 *
 * - The stats interval spun and flooded the log: `bootstrap.ts` armed
 *   `setInterval(log, config.statsIntervalMs)` with the raw value, and
 *   `STATS_INTERVAL_MS=0`, `abc` (NaN) and `1e12` (parseInt -> 1) all produced a ~1 ms
 *   interval (about 870 "Queue statistics" lines per second). A valid period above
 *   2^31 - 1 ms (30 days) did the same, because the runtime rewrites it to 1 ms.
 * - `backup.retention: NaN` in bunqueue.config.ts started a server whose first backup
 *   would delete every stored backup; `S3_BACKUP_RETENTION=abc` silently became 7.
 *
 * Now: an invalid stats interval stops startup with exit code 1 and an error naming the
 * setting (env var or config-file key); a 30-day stats period is honoured. A backup
 * problem never stops the server (2.9.10 ran without backups too): an invalid
 * `backup.retention` disables the backup with an error naming the key, and is never
 * applied; `S3_BACKUP_RETENTION=abc` keeps 7 backups, as 2.9.10's `|| 7` did, with a
 * warning.
 */

import { afterAll, expect, test } from 'bun:test';
import {
  makeSandbox,
  runServer,
  statsLines,
  type ChildRun,
  type Sandbox,
} from './config-test-support';

const sandboxes: Sandbox[] = [];
afterAll(() => {
  for (const sandbox of sandboxes) sandbox.cleanup();
});

function sandbox(config?: unknown): Sandbox {
  const created = makeSandbox('bunqueue-startup-');
  sandboxes.push(created);
  if (config !== undefined) created.writeConfig(config);
  return created;
}

/** Long enough for a fixed server to fail fast, short enough to bound a running one. */
const KILL_AFTER_MS = 4_000;
const TEST_TIMEOUT_MS = 20_000;

const BACKUP = {
  enabled: true,
  bucket: 'bucket',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
};

const CASES: Array<{ label: string; config?: unknown; env?: Record<string, string> }> = [
  { label: 'Invalid STATS_INTERVAL_MS: "0"', env: { STATS_INTERVAL_MS: '0' } },
  { label: 'Invalid STATS_INTERVAL_MS: "abc"', env: { STATS_INTERVAL_MS: 'abc' } },
  { label: 'Invalid STATS_INTERVAL_MS: "1e12"', env: { STATS_INTERVAL_MS: '1e12' } },
  { label: 'timeouts.stats', config: { timeouts: { stats: 0 } } },
];

const BACKUP_CASES: Array<{ label: string; config?: unknown; env?: Record<string, string> }> = [
  {
    label: 'S3 backup configuration invalid',
    config: { backup: { ...BACKUP, retention: Number.NaN } },
  },
  {
    label: 'Invalid S3_BACKUP_RETENTION: \\"abc\\"',
    env: {
      S3_BACKUP_ENABLED: 'true',
      S3_BUCKET: 'bucket',
      S3_ACCESS_KEY_ID: 'key',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_BACKUP_RETENTION: 'abc',
    },
  },
];

test(
  'an invalid setting stops startup with an error naming it',
  async () => {
    const results = await Promise.all(
      CASES.map(async ({ label, config, env }) => {
        const run: ChildRun = await runServer(sandbox(config), {
          env,
          killAfterMs: KILL_AFTER_MS,
        });
        return {
          label,
          exitCode: run.exitCode,
          statsLines: statsLines(run.output),
          named: run.output.includes(label),
        };
      })
    );
    expect(results).toEqual(
      results.map(({ label }) => ({ label, exitCode: 1, statsLines: 0, named: true }))
    );
  },
  TEST_TIMEOUT_MS
);

test(
  'a valid stats period above the native timer limit (30 days) is honoured',
  async () => {
    const run = await runServer(sandbox(), {
      env: { STATS_INTERVAL_MS: '2592000000' },
      killAfterMs: 2_500,
    });
    expect(run.output).toContain('One queue. Any language.');
    // Killed at the deadline (exit code null): the server was still running.
    expect({ exitCode: run.exitCode, statsLines: statsLines(run.output) }).toEqual({
      exitCode: null,
      statsLines: 0,
    });
    expect(run.output).not.toContain('TimeoutOverflowWarning');
  },
  TEST_TIMEOUT_MS
);

test(
  'a backup problem is logged and the server keeps running (never a prune)',
  async () => {
    const results = await Promise.all(
      BACKUP_CASES.map(async ({ label, config, env }) => {
        const run = await runServer(sandbox(config), { env, killAfterMs: 4_000 });
        return { label, exitCode: run.exitCode, named: run.output.includes(label) };
      })
    );
    // Killed at the deadline (exit code null): the server was still running.
    expect(results).toEqual(results.map(({ label }) => ({ label, exitCode: null, named: true })));
  },
  TEST_TIMEOUT_MS
);
