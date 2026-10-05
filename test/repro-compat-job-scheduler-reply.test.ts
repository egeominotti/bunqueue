/**
 * Repro (2.9.10 compatibility): how `upsertJobScheduler` reports a refused schedule.
 *
 * 2.9.10 resolved `null` over TCP when the broker refused a `Cron` command (an invalid
 * pattern or timezone, a fractional interval, no timing at all), and threw in embedded
 * mode, where `addCron` throws. The candidate threw in TCP mode too, so boot code
 * written for 2.9.10 (which checks for `null`) crashed instead of continuing. TCP mode
 * must resolve `null` again, for a template the client refuses before sending as well;
 * embedded mode keeps throwing, as on 2.9.10.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { CoreE2eHarness } from './core-e2e/support/harness';

let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    const value = await promise;
    return value === null ? 'null' : 'info';
  } catch (error) {
    return `throws: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const REFUSED: Array<[string, Record<string, unknown>, Record<string, unknown> | undefined]> = [
  ['an invalid pattern', { pattern: 'nope nope' }, undefined],
  ['a fractional interval', { every: 0.5 }, undefined],
  ['no timing', {}, undefined],
  ['a NaN template timeout', { every: 60_000 }, { timeout: Number.NaN }],
];

describe('upsertJobScheduler reports a refused schedule as on 2.9.10', () => {
  test('TCP mode resolves null', async () => {
    harness = await CoreE2eHarness.start('tcp', 'compat-scheduler-null');
    const queue = harness.queue('compat-scheduler-null');
    const results: Record<string, string> = {};
    for (const [label, repeat, opts] of REFUSED) {
      results[label] = await outcome(
        queue.upsertJobScheduler(`s-${label}`, repeat as never, { name: 't', opts: opts as never })
      );
    }
    expect(results).toEqual(Object.fromEntries(REFUSED.map(([label]) => [label, 'null'])));
    await expect(
      outcome(queue.upsertJobScheduler('valid', { every: 60_000 }, { name: 't' }))
    ).resolves.toBe('info');
  });

  test('embedded mode throws the reason', async () => {
    harness = await CoreE2eHarness.start('embedded', 'compat-scheduler-throw');
    const queue = harness.queue('compat-scheduler-throw');
    const results: Record<string, string> = {};
    for (const [label, repeat, opts] of REFUSED) {
      results[label] = await outcome(
        queue.upsertJobScheduler(`s-${label}`, repeat as never, { name: 't', opts: opts as never })
      );
    }
    expect(results).toEqual({
      'an invalid pattern':
        'throws: Invalid cron expression: Cron expression must have 5 fields, or 6 fields with leading seconds',
      'a fractional interval':
        'throws: Cron repeatEvery must be a positive safe integer number of milliseconds',
      'no timing': 'throws: Cron job must have either schedule or repeatEvery',
      'a NaN template timeout': 'throws: timeout must be a finite number',
    });
  });
});
