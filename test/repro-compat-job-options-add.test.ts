/**
 * Repro (2.9.10 compatibility): job options that 2.9.10 admitted now throw.
 *
 * The 2.9.11 candidate bounded every job option on every path. Several values that
 * 2.9.10 ran with a well-defined result (embedded, TCP or both) were rejected, so an
 * application that worked started losing jobs after the upgrade:
 *
 * - `attempts: 0` (BullMQ's default), `5000`, `MAX_SAFE_INTEGER`, `Infinity`
 *   ("retry forever") and `'3'`;
 * - `priority` above 1,000,000 (BullMQ's 2,097,152), fractional or `'5'`;
 * - `timeout`/`stallTimeout` of 25 h, `timeout` of 2^31 ms;
 * - `sizeLimit` of 20 MB, `stackTraceLimit`/`keepLogs` negative or fractional,
 *   `timestamp: -1`, `deduplication.ttl`/`repeat.every` of 400 days, `delay` of 366 days;
 * - numeric strings (`'3'`, `'200'`, `'5000'`), which 2.9.10 used as numbers, except
 *   `delay: '1000'` and `timeout: '50'`, which string arithmetic broke;
 * - a custom `backoff.type` (`'linear'`), which 2.9.10 ran as exponential.
 *
 * Each must be admitted in both modes with 2.9.10's result (normalized where 2.9.10
 * stored an unusable value), and the remaining errors must name the caller's option.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { jobId } from '../src/domain/types/job';
import { CoreE2eHarness, type CoreE2eMode } from './core-e2e/support/harness';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MAX_ATTEMPTS = 2_147_483_647;

let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function admitted(
  h: CoreE2eHarness,
  opts: Record<string, unknown>
): Promise<Record<string, unknown> | string> {
  const queue = h.queue('compat-add');
  try {
    const job = await queue.add('task', { n: 1 }, opts as never);
    const stored = await h.brokerManager().getJob(jobId(String(job.id)));
    if (!stored) return 'missing';
    return {
      priority: stored.priority,
      maxAttempts: stored.maxAttempts,
      backoff: stored.backoff,
      backoffType: stored.backoffConfig?.type,
      timeout: stored.timeout,
      stallTimeout: stored.stallTimeout,
      delay: stored.runAt - stored.createdAt,
      createdAt: stored.createdAt,
      sizeLimit: stored.sizeLimit,
      keepLogs: stored.keepLogs,
      stackTraceLimit: stored.stackTraceLimit,
      dedupTtl: stored.deduplicationTtl,
      repeatEvery: stored.repeat?.every,
    };
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function pick(value: Record<string, unknown> | string, keys: string[]): unknown {
  if (typeof value === 'string') return value;
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

const CASES: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
  ['attempts 0 runs once', { attempts: 0 }, { maxAttempts: 1 }],
  ['attempts 5000', { attempts: 5000 }, { maxAttempts: 5000 }],
  [
    'attempts MAX_SAFE_INTEGER',
    { attempts: Number.MAX_SAFE_INTEGER },
    { maxAttempts: MAX_ATTEMPTS },
  ],
  ['attempts Infinity', { attempts: Infinity }, { maxAttempts: MAX_ATTEMPTS }],
  ['attempts 2.5 (2.9.10 ran 3 attempts)', { attempts: 2.5 }, { maxAttempts: 3 }],
  ["attempts '3'", { attempts: '3' }, { maxAttempts: 3 }],
  ['priority 2097152', { priority: 2_097_152 }, { priority: 2_097_152 }],
  ['priority 2^31', { priority: 2 ** 31 }, { priority: 2 ** 31 }],
  ['priority 1.5', { priority: 1.5 }, { priority: 1.5 }],
  ["priority '5'", { priority: '5' }, { priority: 5 }],
  ['timeout 25h', { timeout: 25 * HOUR }, { timeout: 25 * HOUR }],
  ['timeout 2^31', { timeout: 2 ** 31 }, { timeout: 2 ** 31 }],
  ["timeout '5000'", { timeout: '5000' }, { timeout: 5000 }],
  ['stallTimeout 25h', { stallTimeout: 25 * HOUR }, { stallTimeout: 25 * HOUR }],
  ['stallTimeout -1', { stallTimeout: -1 }, { stallTimeout: -1 }],
  ['sizeLimit 20MB', { sizeLimit: 20 * 1024 * 1024 }, { sizeLimit: 20 * 1024 * 1024 }],
  ['sizeLimit 1.5', { sizeLimit: 1.5 }, { sizeLimit: 1.5 }],
  ['keepLogs -1', { keepLogs: -1 }, { keepLogs: -1 }],
  ['keepLogs 1.5', { keepLogs: 1.5 }, { keepLogs: 1.5 }],
  ['stackTraceLimit -1', { stackTraceLimit: -1 }, { stackTraceLimit: -1 }],
  ['stackTraceLimit 1.5', { stackTraceLimit: 1.5 }, { stackTraceLimit: 1.5 }],
  ['timestamp -1', { timestamp: -1 }, { createdAt: -1 }],
  ["backoff '200'", { backoff: '200' }, { backoff: 200 }],
  ['backoff 25h', { backoff: 25 * HOUR }, { backoff: 25 * HOUR }],
  [
    "backoff {type:'linear'} runs as exponential",
    { backoff: { type: 'linear', delay: 500 } },
    { backoff: 500, backoffType: 'linear' },
  ],
  ['delay 366 days', { delay: 366 * DAY }, { delay: 366 * DAY }],
  ["delay '1000'", { delay: '1000' }, { delay: 1000 }],
  [
    'deduplication ttl 400 days',
    { deduplication: { id: `d-${crypto.randomUUID()}`, ttl: 400 * DAY } },
    { dedupTtl: 400 * DAY },
  ],
  ['repeat every 400 days', { repeat: { every: 400 * DAY, limit: 1 } }, { repeatEvery: 400 * DAY }],
];

for (const mode of ['embedded', 'tcp'] as CoreE2eMode[]) {
  describe(`2.9.10 job options are admitted (${mode})`, () => {
    test('every value 2.9.10 ran is admitted with its result', async () => {
      harness = await CoreE2eHarness.start(mode, 'compat-add');
      const mismatches: string[] = [];
      for (const [label, opts, expected] of CASES) {
        const actual = pick(await admitted(harness, opts), Object.keys(expected));
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          mismatches.push(`${label}: ${JSON.stringify(actual)}`);
        }
      }
      expect(mismatches).toEqual([]);
    });

    test('addBulk, defaultJobOptions and repeat admit the same values', async () => {
      harness = await CoreE2eHarness.start(mode, 'compat-add-paths');
      const opts = { attempts: 0, priority: 2_097_152, timeout: 25 * HOUR, sizeLimit: 2e7 };
      const queue = harness.queue('compat-bulk');
      const bulk = await queue.addBulk([{ name: 'a', data: {}, opts }]);
      expect(bulk).toHaveLength(1);
      const defaults = harness.queue('compat-defaults', { defaultJobOptions: opts });
      await expect(defaults.add('d', {})).resolves.toBeDefined();
      await expect(
        queue.add('r', {}, { ...opts, repeat: { every: 60_000, limit: 1 } })
      ).resolves.toBeDefined();
    });

    test('errors name the option as the caller passed it', async () => {
      harness = await CoreE2eHarness.start(mode, 'compat-add-names');
      const outcomes = {
        attempts: await admitted(harness, { attempts: Number.NaN }),
        textAttempts: await admitted(harness, { attempts: 'three' }),
        dedup: await admitted(harness, {
          deduplication: { id: 'x', ttl: Number.NaN },
        }),
        debounce: await admitted(harness, { debounce: { id: 'y', ttl: Number.NaN } }),
      };
      expect(outcomes).toEqual({
        attempts: 'error: attempts must be a number',
        textAttempts: 'error: attempts must be a number',
        dedup: 'error: deduplication.ttl must be a finite number',
        debounce: 'error: debounce.ttl must be a finite number',
      });
    });
  });
}

describe('FlowProducer admits the same options', () => {
  test('attempts 0 and priority 2097152 are admitted; errors say attempts', async () => {
    harness = await CoreE2eHarness.start('embedded', 'compat-flow');
    const manager = harness.brokerManager(); // the shared manager the flow reuses
    const flow = harness.flow();
    const queueName = harness.unique('compat-flow');
    const node = await flow.add({
      name: 'parent',
      queueName,
      data: {},
      opts: { attempts: 0, priority: 2_097_152, timeout: 25 * HOUR },
      children: [{ name: 'child', queueName, data: {}, opts: { attempts: 5000 } }],
    });
    const parent = await manager.getJob(jobId(String(node.job.id)));
    expect({ maxAttempts: parent?.maxAttempts, priority: parent?.priority }).toEqual({
      maxAttempts: 1,
      priority: 2_097_152,
    });
    await expect(
      flow.add({ name: 'bad', queueName, data: {}, opts: { attempts: Number.NaN } })
    ).rejects.toThrow('attempts must be a number');
  });
});
