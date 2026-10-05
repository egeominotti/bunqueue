/**
 * Repro: job options are validated in TCP mode but not in embedded mode.
 *
 * TCP PUSH/PUSHB rejected out-of-range options while embedded `Queue.add` and
 * `Queue.addBulk` accepted anything: a NaN delay produced a job that never became
 * ready, a 3e9 ms timeout overflowed the runtime timer, `{ type: 'fixed' }` produced
 * a NaN retry delay, and NaN fields were silently dropped by the SQLite write buffer
 * (`NOT NULL constraint failed`). TCP itself never applied the documented 1-day
 * `stallTimeout` bound, nor any bound on `timestamp`, `dedup.ttl`, `debounceTtl`,
 * `keepLogs` or `repeat.every`.
 *
 * Both modes must now reject the same inputs with the same message. Only what cannot
 * run is rejected: values 2.9.10 ran keep their 2.9.10 result.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { JobOptions } from '../src/client';
import { CoreE2eHarness, type CoreE2eMode } from './core-e2e/support/harness';

let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

const DAY = 86_400_000;
const YEAR = 365 * DAY;

/**
 * Options that must be rejected, with the exact message both modes report. Values 2.9.10
 * ran with a well-defined result (a timeout or stallTimeout above a day, a delay above a
 * year, attempts above 1000, a negative keepLogs) are admitted:
 * repro-compat-job-options-add.test.ts.
 */
const INVALID: ReadonlyArray<readonly [string, JobOptions, string]> = [
  ['NaN timeout', { timeout: Number.NaN }, 'timeout must be a finite number'],
  ['negative timeout', { timeout: -1 }, 'timeout must be at least 0'],
  // A negative delay is accepted and means 0 (repro-job-options-negative-delay).
  ['infinite delay', { delay: Infinity }, 'delay must be a finite number'],
  ['NaN delay', { delay: Number.NaN }, 'delay must be a finite number'],
  ['negative ttl', { ttl: -1 } as JobOptions, 'ttl must be at least 0'],
  ['NaN backoff', { backoff: Number.NaN }, 'backoff must be a finite number'],
  // A backoff object without delay uses the 1000 ms default (2.9.10 compatibility,
  // repro-compat-job-priority-backoff.test.ts); a NaN delay is still refused.
  [
    'backoff object with a NaN delay',
    { backoff: { type: 'fixed', delay: Number.NaN } },
    'backoff.delay must be a finite number',
  ],
  ['NaN stallTimeout', { stallTimeout: Number.NaN }, 'stallTimeout must be a finite number'],
  ['NaN attempts', { attempts: Number.NaN }, 'attempts must be a number'],
  // A negative `attempts` runs once (2.9.10; repro-compat-job-past-run-time.test.ts).
  ['text attempts', { attempts: 'three' as unknown as number }, 'attempts must be a number'],
  ['NaN timestamp', { timestamp: Number.NaN }, 'timestamp must be a finite number'],
  ['timestamp beyond the Date range', { timestamp: 1e16 }, 'timestamp must be at most'],
  [
    'NaN deduplication ttl',
    { deduplication: { id: 'dedup-nan', ttl: Number.NaN } },
    'deduplication.ttl must be a finite number',
  ],
  [
    'NaN debounce ttl',
    { debounce: { id: 'debounce', ttl: Number.NaN } },
    'debounce.ttl must be a finite number',
  ],
  ['NaN keepLogs', { keepLogs: Number.NaN }, 'keepLogs must be a finite number'],
  ['repeat.every of 0', { repeat: { every: 0 } }, 'repeat.every must be a positive finite number'],
];

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '<accepted>';
}

describe.each(['embedded', 'tcp'] as const)(
  'job option validation parity (%s)',
  (mode: CoreE2eMode) => {
    test('Queue.add rejects every out-of-range option with the shared message', async () => {
      harness = await CoreE2eHarness.start(mode, 'job-options-add');
      const queue = harness.queue('job-options-add');
      const mismatches: string[] = [];
      for (const [label, options, message] of INVALID) {
        const error = await rejection(queue.add('task', { label }, options));
        if (!error.includes(message)) mismatches.push(`${label}: ${error}`);
      }
      expect(mismatches).toEqual([]);
      expect(await queue.count()).toBe(0);
    });

    test('Queue.addBulk names the offending job and admits nothing', async () => {
      harness = await CoreE2eHarness.start(mode, 'job-options-bulk');
      const queue = harness.queue('job-options-bulk');
      const error = await rejection(
        queue.addBulk([
          { name: 'ok', data: {} },
          { name: 'bad', data: {}, opts: { timeout: -1 } },
        ])
      );
      expect(error).toBe('jobs[1]: timeout must be at least 0');
      expect(await queue.count()).toBe(0);
    });

    test('valid boundary values are still accepted', async () => {
      harness = await CoreE2eHarness.start(mode, 'job-options-valid');
      const queue = harness.queue('job-options-valid');
      const job = await queue.add(
        'task',
        {},
        {
          delay: YEAR,
          timeout: DAY,
          stallTimeout: DAY,
          attempts: 1000,
          backoff: { type: 'exponential', delay: DAY, maxDelay: DAY },
          timestamp: Date.now(),
          deduplication: { id: 'boundary', ttl: YEAR },
          keepLogs: 0,
        }
      );
      expect(await queue.getJobState(job.id)).toBe('delayed');
      const fractional = await queue.add('task', {}, { timeout: 1.5, delay: 0.5 });
      expect(fractional.id).toBeString();
    });
  }
);
