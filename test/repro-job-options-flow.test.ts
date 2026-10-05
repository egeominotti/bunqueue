/**
 * Repro: atomic flows validated job options with their own rules.
 *
 * `validateAtomicFlowBatch` kept a private copy of the PUSH bounds: the object-form
 * `backoff.delay` was not checked (so a NaN delay produced a NaN retry delay; a missing
 * one now uses the 1000 ms default, as on every path),
 * `timestamp` accepted values beyond the JavaScript Date range, and the messages
 * differed from PUSH (`attempts must be between 1 and 1000` versus
 * `maxAttempts must be at least 1`). Flows now use the shared job-option validator,
 * in both modes, and name the option as the caller passed it (`attempts`).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { JobOptions } from '../src/client';
import { CoreE2eHarness, type CoreE2eMode } from './core-e2e/support/harness';

let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

const CASES: ReadonlyArray<readonly [string, JobOptions, string]> = [
  // A backoff object without delay uses the 1000 ms default (2.9.10 compatibility,
  // repro-compat-job-priority-backoff.test.ts); a NaN delay is still refused.
  [
    'backoff object with a NaN delay',
    { backoff: { type: 'fixed', delay: Number.NaN } },
    'backoff.delay must be a finite number',
  ],
  ['NaN attempts', { attempts: Number.NaN }, 'attempts must be a number'],
  ['timestamp beyond the Date range', { timestamp: 9e15 }, 'timestamp must be at most'],
  ['NaN stallTimeout', { stallTimeout: Number.NaN }, 'stallTimeout must be a finite number'],
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
  'flow job option validation (%s)',
  (mode: CoreE2eMode) => {
    test('a flow node is rejected with the same message as Queue.add', async () => {
      harness = await CoreE2eHarness.start(mode, 'job-options-flow');
      const flow = harness.flow();
      const queue = harness.queue('job-options-flow');
      const mismatches: string[] = [];
      for (const [label, opts, message] of CASES) {
        const flowError = await rejection(
          flow.add({
            name: 'parent',
            queueName: queue.name,
            data: {},
            children: [{ name: 'child', queueName: queue.name, data: {}, opts }],
          })
        );
        const addError = await rejection(queue.add('single', {}, opts));
        if (!flowError.includes(message) || !addError.includes(message)) {
          mismatches.push(`${label}: flow=${flowError} add=${addError}`);
        }
      }
      expect(mismatches).toEqual([]);
      expect(await queue.count()).toBe(0);
    });
  }
);
