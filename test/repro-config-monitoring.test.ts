/**
 * Repro: the monitoring thresholds were read with a raw `parseInt` at module load and
 * only used in comparisons, so a typo silently changed or disabled an alert:
 *
 * - `QUEUE_IDLE_THRESHOLD_MS=1e12` became 1 ms: `queue:idle` fired on the second check
 *   instead of after the configured idle time;
 * - `QUEUE_IDLE_THRESHOLD_MS=abc` (NaN) disabled the check (`now - since >= NaN` is
 *   never true), as did NaN for every other threshold.
 *
 * Each must now be rejected with an error naming the variable: at server startup and
 * when an embedded QueueManager is created. The module-level read made the old values
 * unobservable in-process, so the embedded cases run in a fresh process. A negative or
 * unreadable threshold is not here: 2.9.10 skipped every check `<= 0` and never fired
 * one compared with NaN, so `-1` and `abc` still mean 0 (disabled), now with a warning
 * (test/repro-compat-config-env-numbers.test.ts). Misreads stay errors.
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { resolveServerConfig } from '../src/config/resolve';
import { makeSandbox, outcome, REPO, runChild, withEnv } from './config-test-support';

const env = withEnv();
afterEach(() => env.restore());

const box = makeSandbox('bunqueue-monitoring-config-');
afterAll(() => box.cleanup());

const CASES = [
  ['QUEUE_IDLE_THRESHOLD_MS', '1e12'],
  ['QUEUE_IDLE_THRESHOLD_MS', '1h'],
  ['QUEUE_SIZE_THRESHOLD', '5k'],
  ['WORKER_OVERLOAD_THRESHOLD_MS', '30s'],
  ['MEMORY_WARNING_MB', '1.5e3'],
  ['STORAGE_WARNING_MB', '1e3'],
] as const;

describe('server startup (finding 10)', () => {
  test.each(CASES)('rejects %s=%p', (name, raw) => {
    env.set({ [name]: raw });
    expect(outcome(() => resolveServerConfig(null))).toEqual({
      error: expect.stringContaining(`Invalid ${name}: ${JSON.stringify(raw)}`),
    });
  });

  test('keeps 0 as "disabled" for every threshold', () => {
    env.set({
      QUEUE_IDLE_THRESHOLD_MS: '0',
      QUEUE_SIZE_THRESHOLD: '0',
      WORKER_OVERLOAD_THRESHOLD_MS: '0',
      MEMORY_WARNING_MB: '0',
      STORAGE_WARNING_MB: '0',
    });
    expect('value' in outcome(() => resolveServerConfig(null))).toBe(true);
  });
});

const IDLE_SCRIPT = box.writeFile(
  'idle.ts',
  `
import { SHARD_COUNT, shardIndex } from ${JSON.stringify(join(REPO, 'src/shared/hash.ts'))};
import * as monitoring from ${JSON.stringify(join(REPO, 'src/application/monitoringChecks.ts'))};
let report: Record<string, unknown>;
try {
  const events: string[] = [];
  const shards = Array.from({ length: SHARD_COUNT }, () => ({ queues: new Map() }));
  shards[shardIndex('q')].queues.set('q', new Map());
  const ctx = {
    queueNamesCache: new Set(['q']),
    shards,
    processingShards: [],
    workerManager: { list: () => [] },
    storage: null,
    dashboardEmit: (event: string) => events.push(event),
    state: monitoring.createMonitoringState(),
  };
  monitoring.runMonitoringChecks(ctx as never);
  await Bun.sleep(20);
  monitoring.runMonitoringChecks(ctx as never);
  report = { created: true, events };
} catch (error) {
  report = { created: false, error: error instanceof Error ? error.message : String(error) };
}
console.log(JSON.stringify(report));
`
);

describe('embedded QueueManager / monitoring state (finding 10)', () => {
  test.each(CASES)(
    'rejects %s=%p when the monitoring state is created',
    async (name, raw) => {
      const run = await runChild([IDLE_SCRIPT], {
        cwd: box.dir,
        env: { [name]: raw },
        killAfterMs: 10_000,
      });
      const line = run.output
        .split('\n')
        .reverse()
        .find((item) => item.startsWith('{'));
      expect(line ? JSON.parse(line) : run.output).toEqual({
        created: false,
        error: expect.stringContaining(`Invalid ${name}: ${JSON.stringify(raw)}`),
      });
    },
    15_000
  );
});
