/**
 * Repro: `timeouts.worker` and `timeouts.lock` in bunqueue.config.ts were accepted and
 * then ignored (the runtime only read WORKER_TIMEOUT_MS / LOCK_TIMEOUT_MS), so an
 * operator who set them in the file kept the env or default values without a word.
 * A malformed LOCK_TIMEOUT_MS / WORKER_* also surfaced as "Failed to initialize storage".
 * The PostgreSQL Cloud adapter hardcoded the 30 s worker freshness window.
 *
 * The file keys stay ignored, as 2.9.10 documented them (applying them would change a
 * running deployment on upgrade: a `lock: 5` meant as seconds became a 5 ms lock wait),
 * now with a warning naming the env var to use. The env values reach the runtime: the
 * lock acquisition timeout and the worker freshness window of a booted server. The
 * runtime settings are validated with the rest of the configuration, so a bad value is
 * reported as a configuration error before storage opens.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { resolveServerConfig } from '../src/config';
import type { BunqueueConfig } from '../src/config';
import { makeSandbox, outcome, REPO, runChild, runServer, withEnv } from './config-test-support';

const box = makeSandbox('bunqueue-runtime-timeouts-');
const serverBox = makeSandbox('bunqueue-runtime-timeouts-server-');
afterAll(() => {
  box.cleanup();
  serverBox.cleanup();
});

const env = withEnv();

function resolve(file: unknown, vars: Record<string, string | undefined> = {}) {
  env.set(vars);
  try {
    return outcome(() => resolveServerConfig(file as BunqueueConfig));
  } finally {
    env.restore();
  }
}

describe('resolution (env > default; the file keys are ignored)', () => {
  test('env values apply, defaults last; the file keys only warn', () => {
    const result = resolve(
      { timeouts: { worker: 1_500, lock: 250 } },
      { WORKER_TIMEOUT_MS: '60000', LOCK_TIMEOUT_MS: '60000' }
    );
    expect(result).toEqual({
      value: expect.objectContaining({ workerTimeoutMs: 60_000, lockTimeoutMs: 60_000 }),
    });
    const warnings = 'value' in result ? result.value.configWarnings : [];
    expect(warnings).toEqual([
      expect.stringContaining('timeouts.worker'),
      expect.stringContaining('timeouts.lock'),
    ]);
    expect(resolve(null, { WORKER_TIMEOUT_MS: '45000', LOCK_TIMEOUT_MS: '7000' })).toEqual({
      value: expect.objectContaining({ workerTimeoutMs: 45_000, lockTimeoutMs: 7_000 }),
    });
    expect(resolve(null, { WORKER_TIMEOUT_MS: undefined, LOCK_TIMEOUT_MS: undefined })).toEqual({
      value: expect.objectContaining({ workerTimeoutMs: 30_000, lockTimeoutMs: 5_000 }),
    });
  });

  test.each([
    ['timeouts.worker', { timeouts: { worker: 0 } }],
    ['timeouts.lock', { timeouts: { lock: Number.NaN } }],
    ['timeouts.lock', { timeouts: { lock: '5000' } }],
  ])('an invalid %s is ignored too (it never took effect)', (key, file) => {
    expect(resolve(file)).toEqual({
      value: expect.objectContaining({ configWarnings: [expect.stringContaining(key)] }),
    });
  });

  test.each([
    ['LOCK_TIMEOUT_MS', 'abc'],
    ['WORKER_TIMEOUT_MS', '1e12'],
    ['WORKER_CLEANUP_INTERVAL_MS', '0'],
  ])('%s=%p is a configuration error, reported before storage opens', (name, raw) => {
    expect(resolve(null, { [name]: raw })).toEqual({
      error: `Invalid ${name}: ${JSON.stringify(raw)} (expected a whole number of milliseconds >= 1)`,
    });
  });
});

test('a booted server applies the env values, not the ignored file keys', async () => {
  const script = box.writeFile(
    'boot.ts',
    `
import { resolveServerConfig } from ${JSON.stringify(join(REPO, 'src/config/index.ts'))};
import { bootServer } from ${JSON.stringify(join(REPO, 'src/infrastructure/server/bootstrap.ts'))};
import { AsyncLock } from ${JSON.stringify(join(REPO, 'src/shared/asyncLock.ts'))};
import * as storage from ${JSON.stringify(join(REPO, 'src/infrastructure/server/storageManager.ts'))};

const fileConfig = {
  server: { tcpPort: 0, httpPort: 0, host: '127.0.0.1' },
  storage: { driver: 'memory' as const },
  timeouts: { shutdown: 0, stats: 60_000, worker: 60_000, lock: 60_000 },
};
let manager: any;
const original = storage.serverStorageManager.create.bind(storage.serverStorageManager);
storage.serverStorageManager.create = async (config) => (manager = await original(config));
await bootServer(fileConfig, resolveServerConfig(fileConfig));

const lock = new AsyncLock();
await lock.acquire();
const started = performance.now();
const waited = await lock.acquire().then(
  () => -1,
  () => Math.round(performance.now() - started)
);
const worker = manager.workerManager.register('w1', ['q'], 1);
worker.lastSeen = Date.now() - 5_000;
console.log(JSON.stringify({ lockWaitMs: waited, activeWorkers: manager.workerManager.getStats().active }));
process.kill(process.pid, 'SIGTERM');
`
  );
  const run = await runChild([script], {
    cwd: box.dir,
    env: { WORKER_TIMEOUT_MS: '1500', LOCK_TIMEOUT_MS: '250', LOG_LEVEL: 'error' },
    killAfterMs: 15_000,
  });
  const line = run.output.split('\n').find((item) => item.startsWith('{"lockWaitMs"'));
  expect(line, run.output).toBeDefined();
  const report = JSON.parse(line!) as { lockWaitMs: number; activeWorkers: number };
  // 250 ms from the env, not 60 s from the file; a 5 s silent worker is stale at 1.5 s.
  expect(report.lockWaitMs).toBeGreaterThanOrEqual(200);
  expect(report.lockWaitMs).toBeLessThan(5_000);
  expect(report.activeWorkers).toBe(0);
}, 20_000);

test('a malformed runtime env var prints one clean Fatal error line, not a storage failure', async () => {
  const run = await runServer(serverBox, {
    env: { LOCK_TIMEOUT_MS: 'abc' },
    killAfterMs: 4_000,
  });
  expect({ exitCode: run.exitCode, output: run.output.trim() }).toEqual({
    exitCode: 1,
    output:
      'Fatal error: Invalid LOCK_TIMEOUT_MS: "abc" (expected a whole number of milliseconds >= 1)',
  });
}, 15_000);

test('the PostgreSQL Cloud adapter uses the configured worker freshness window', async () => {
  const script = box.writeFile(
    'pg-adapter.ts',
    `
import { PostgresCloudQueueAdapter } from ${JSON.stringify(join(REPO, 'src/infrastructure/cloud/queueAdapter/postgres.ts'))};
const now = Date.now();
const worker = (id: string, age: number) => ({
  id, name: id, queues: ['q'], concurrency: 2, activeJobs: 0, processedJobs: 0, failedJobs: 0,
  lastSeen: now - age, registeredAt: now - age,
});
const manager = {
  readCloudSnapshotDurable: async () => ({
    jobs: [], queueStates: [], counts: [], totals: [], results: [], logs: new Map(), crons: [],
    workers: [worker('fresh', 1_000), worker('quiet', 45_000), worker('gone', 90_000)],
  }),
  getCloudProcessStats: () => ({}),
};
const source = await new PostgresCloudQueueAdapter(manager as never).readSnapshotSource();
console.log(JSON.stringify(source.workerStats));
`
  );
  const run = await runChild([script], {
    cwd: box.dir,
    env: { WORKER_TIMEOUT_MS: '60000' },
    killAfterMs: 10_000,
  });
  const line = run.output.split('\n').find((item) => item.startsWith('{'));
  expect(line, run.output).toBeDefined();
  expect(JSON.parse(line!)).toMatchObject({ total: 3, active: 2, concurrencySlots: 4 });
}, 15_000);
