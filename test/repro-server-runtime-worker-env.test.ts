/**
 * Repro: WORKER_CLEANUP_INTERVAL_MS and WORKER_TIMEOUT_MS were read with a raw parseInt.
 *
 * - WORKER_CLEANUP_INTERVAL_MS drives the WorkerManager setInterval that every
 *   QueueManager (embedded included) starts. `-1`, `0`, `abc` (NaN), `1e12` (parseInt: 1)
 *   or a value above 2^31 - 1 made it tick about every millisecond.
 * - WORKER_TIMEOUT_MS: `1e12` (parseInt: 1) or `abc` (NaN) marked every worker stale at
 *   once, so `skipIfNoWorker` crons and the worker views saw no live worker.
 *
 * Each case runs in a fresh process because the variables are read once per process.
 */

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO, TIMER_WARNING, runChild } from './server-runtime-support';

setDefaultTimeout(60_000);

/** Start a WorkerManager, count its stale-worker sweeps for 250 ms. */
const SWEEP_PROBE = `
  const { WorkerManager } = await import('${REPO}/src/application/workerManager.ts');
  let sweeps = 0;
  const proto = WorkerManager.prototype as unknown as { cleanupStale(): void };
  const sweep = proto.cleanupStale;
  proto.cleanupStale = function (this: unknown) {
    sweeps++;
    sweep.call(this);
  };
  const manager = new WorkerManager();
  await Bun.sleep(250);
  manager.stop();
  report({ sweeps });
`;

/** Register one worker, then read the liveness views 20 ms later. */
const LIVENESS_PROBE = `
  const { WorkerManager } = await import('${REPO}/src/application/workerManager.ts');
  const manager = new WorkerManager();
  manager.register('worker', ['emails']);
  await Bun.sleep(20);
  const active = manager.listActive().length;
  const forQueue = manager.getForQueue('emails').length;
  const statsActive = manager.getStats().active;
  manager.stop();
  report({ active, forQueue, statsActive });
`;

describe('WORKER_CLEANUP_INTERVAL_MS', () => {
  test('values that made the cleanup interval spin are rejected with the variable named', async () => {
    const raws = ['-1', '0', 'abc', '1e12', '60s', '1.5e3'];
    const results = await Promise.all(
      raws.map((raw) => runChild(SWEEP_PROBE, { WORKER_CLEANUP_INTERVAL_MS: raw }))
    );
    for (const [index, raw] of raws.entries()) {
      expect(results[index].report).toEqual({
        ok: false,
        name: 'Error',
        error: `Invalid WORKER_CLEANUP_INTERVAL_MS: ${JSON.stringify(raw)} (expected a whole number of milliseconds >= 1)`,
      });
    }
  });

  test('a period above the native timer limit is honoured, not turned into a spin', async () => {
    const result = await runChild(SWEEP_PROBE, { WORKER_CLEANUP_INTERVAL_MS: '99999999999' });
    expect(result.report).toEqual({ ok: true, sweeps: 0 });
    expect(result.output).not.toMatch(TIMER_WARNING);
  });

  test('an unset or empty variable keeps the 60 s default', async () => {
    const [unset, empty] = await Promise.all([
      runChild(SWEEP_PROBE, {}),
      runChild(SWEEP_PROBE, { WORKER_CLEANUP_INTERVAL_MS: '' }),
    ]);
    expect(unset.report).toEqual({ ok: true, sweeps: 0 });
    expect(empty.report).toEqual({ ok: true, sweeps: 0 });
  });
});

describe('WORKER_TIMEOUT_MS', () => {
  test('values parseInt misread are rejected instead of marking every worker stale', async () => {
    const raws = ['1e12', 'abc', '0', '-5', '30s'];
    const results = await Promise.all(
      raws.map((raw) => runChild(LIVENESS_PROBE, { WORKER_TIMEOUT_MS: raw }))
    );
    for (const [index, raw] of raws.entries()) {
      expect(results[index].report).toEqual({
        ok: false,
        name: 'Error',
        error: `Invalid WORKER_TIMEOUT_MS: ${JSON.stringify(raw)} (expected a whole number of milliseconds >= 1)`,
      });
    }
  });

  test('a valid window keeps a fresh worker active in every view', async () => {
    const results = await Promise.all([
      runChild(LIVENESS_PROBE, {}),
      runChild(LIVENESS_PROBE, { WORKER_TIMEOUT_MS: '99999999999' }),
    ]);
    for (const result of results) {
      expect(result.report).toEqual({ ok: true, active: 1, forQueue: 1, statsActive: 1 });
    }
  });
});

describe('embedded mode', () => {
  test('a malformed worker variable fails the first embedded Queue, naming the variable', async () => {
    const result = await runChild(
      `
        const { Queue } = await import('${REPO}/src/client/index.ts');
        new Queue('runtime-env', { embedded: true });
        report({ constructed: true });
      `,
      { WORKER_CLEANUP_INTERVAL_MS: 'abc' }
    );
    expect(result.report).toMatchObject({
      ok: false,
      error: expect.stringContaining('Invalid WORKER_CLEANUP_INTERVAL_MS: "abc"'),
    });
  });

  test('importing the server entry module never evaluates the variables', async () => {
    const result = await runChild(
      `
        const main = await import('${REPO}/src/main.ts');
        report({ defineConfig: typeof main.defineConfig });
      `,
      { WORKER_CLEANUP_INTERVAL_MS: 'abc', WORKER_TIMEOUT_MS: 'abc' }
    );
    expect(result.report).toEqual({ ok: true, defineConfig: 'function' });
  });
});
