/**
 * Unit tests for the DelayedError re-delay computation and for the TCP worker
 * parser that must deliver the object-form backoff (including `maxDelay`) so
 * the computation can see the cap.
 */

import { describe, expect, test } from 'bun:test';
import { buildJobOpts } from '../src/client/jobHelpers';
import { parseJobFromResponse } from '../src/client/worker/jobParser';
import { DEFAULT_MAX_BACKOFF, MAX_BACKOFF_DELAY } from '../src/domain/job/constants';
import { calculateDelayedErrorDelay } from '../src/domain/job/state';
import type { BackoffConfig } from '../src/domain/types/job';

function delayFor(backoff: number, backoffConfig: BackoffConfig | null = null): number {
  return calculateDelayedErrorDelay({ backoff, backoffConfig });
}

describe('calculateDelayedErrorDelay', () => {
  test('numeric backoff is the base delay', () => {
    expect(delayFor(5_000)).toBe(5_000);
  });

  test('numeric backoff is capped at the 1-hour default', () => {
    expect(delayFor(DEFAULT_MAX_BACKOFF * 2)).toBe(DEFAULT_MAX_BACKOFF);
  });

  test('a zero numeric backoff falls back to 1000 ms', () => {
    expect(delayFor(0)).toBe(1_000);
  });

  test('object form uses backoff.delay as the base', () => {
    expect(delayFor(7, { type: 'fixed', delay: 4_000 })).toBe(4_000);
  });

  test('object form without maxDelay is capped at the 1-hour default', () => {
    expect(delayFor(MAX_BACKOFF_DELAY, { type: 'fixed', delay: MAX_BACKOFF_DELAY })).toBe(
      DEFAULT_MAX_BACKOFF
    );
  });

  test('maxDelay caps a larger base delay', () => {
    expect(delayFor(60_000, { type: 'fixed', delay: 60_000, maxDelay: 2_000 })).toBe(2_000);
  });

  test('maxDelay above the base leaves the base unchanged', () => {
    expect(delayFor(3_000, { type: 'fixed', delay: 3_000, maxDelay: 10_000 })).toBe(3_000);
  });

  test('exponential type does not grow and is not jittered', () => {
    const config: BackoffConfig = { type: 'exponential', delay: 2_500, maxDelay: 10_000 };
    const samples = Array.from({ length: 20 }, () => delayFor(2_500, config));
    expect(new Set(samples)).toEqual(new Set([2_500]));
  });

  test('a zero object delay falls back to 1000 ms before the cap', () => {
    expect(delayFor(0, { type: 'fixed', delay: 0 })).toBe(1_000);
    expect(delayFor(0, { type: 'fixed', delay: 0, maxDelay: 500 })).toBe(500);
  });

  // Spec change: maxDelay 0 does not apply to DelayedError; a zero wait spins.
  // It means "retry failures immediately", and DelayedError is not a failure,
  // so the job waits its base delay under the default cap instead.
  test('maxDelay 0 does not apply: the base delay is used under the default cap', () => {
    expect(delayFor(60_000, { type: 'fixed', delay: 60_000, maxDelay: 0 })).toBe(60_000);
    expect(delayFor(0, { type: 'exponential', delay: 0, maxDelay: 0 })).toBe(1_000);
    expect(
      delayFor(MAX_BACKOFF_DELAY, { type: 'fixed', delay: MAX_BACKOFF_DELAY, maxDelay: 0 })
    ).toBe(DEFAULT_MAX_BACKOFF);
  });

  test('a negative or NaN base falls back to 1000 ms', () => {
    expect(delayFor(-5_000)).toBe(1_000);
    expect(delayFor(Number.NaN)).toBe(1_000);
    expect(delayFor(0, { type: 'fixed', delay: -5_000 })).toBe(1_000);
    expect(delayFor(0, { type: 'fixed', delay: Number.NaN, maxDelay: 2_000 })).toBe(1_000);
    expect(delayFor(0, { type: 'fixed', delay: -1, maxDelay: 500 })).toBe(500);
  });

  test('an unusable maxDelay falls back to the 1-hour default cap', () => {
    for (const maxDelay of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(delayFor(0, { type: 'fixed', delay: 5_000, maxDelay })).toBe(5_000);
      expect(delayFor(0, { type: 'fixed', delay: MAX_BACKOFF_DELAY, maxDelay })).toBe(
        DEFAULT_MAX_BACKOFF
      );
    }
  });

  test('the wait is always positive and finite, whatever the inputs', () => {
    const values = [
      0,
      -0,
      -1,
      0.5,
      1,
      1_000,
      DEFAULT_MAX_BACKOFF,
      MAX_BACKOFF_DELAY,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    const expectUsable = (result: number, cap: number) => {
      expect(Number.isFinite(result)).toBe(true);
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThanOrEqual(cap);
    };
    for (const base of values) {
      expectUsable(delayFor(base), DEFAULT_MAX_BACKOFF);
      for (const maxDelay of [undefined, ...values]) {
        // Only a positive finite maxDelay replaces the default cap.
        const cap =
          maxDelay !== undefined && Number.isFinite(maxDelay) && maxDelay > 0
            ? maxDelay
            : DEFAULT_MAX_BACKOFF;
        for (const type of ['fixed', 'exponential'] as const) {
          expectUsable(delayFor(0, { type, delay: base, maxDelay }), cap);
        }
      }
    }
  });
});

describe('parseJobFromResponse backoffConfig', () => {
  const parse = (backoffConfig: unknown, backoff = 60_000) =>
    parseJobFromResponse({ id: 'job-1', name: 'n', data: {}, backoff, backoffConfig }, 'q');

  test('reads the object-form backoff including maxDelay', () => {
    const job = parse({ type: 'fixed', delay: 60_000, maxDelay: 2_000 });
    expect(job.backoffConfig).toEqual({ type: 'fixed', delay: 60_000, maxDelay: 2_000 });
    expect(job.backoff).toBe(60_000);
  });

  test('reads an object-form backoff without maxDelay', () => {
    const job = parse({ type: 'exponential', delay: 300 }, 300);
    expect(job.backoffConfig).toEqual({ type: 'exponential', delay: 300 });
    expect(job.backoffConfig && 'maxDelay' in job.backoffConfig).toBe(false);
  });

  test('a missing field (older server) or null (numeric backoff) yields null', () => {
    expect(
      parseJobFromResponse({ id: 'job-1', name: 'n', data: {}, backoff: 500 }, 'q').backoffConfig
    ).toBeNull();
    expect(parse(null, 500).backoffConfig).toBeNull();
  });

  test('a malformed config yields null', () => {
    expect(parse({ type: 'linear', delay: 1_000 }).backoffConfig).toBeNull();
    expect(parse({ type: 'fixed', delay: '1000' }).backoffConfig).toBeNull();
    expect(parse({ type: 'fixed', delay: Number.NaN }).backoffConfig).toBeNull();
    expect(parse({ type: 'fixed' }).backoffConfig).toBeNull();
    expect(parse('fixed').backoffConfig).toBeNull();
    expect(parse(5_000).backoffConfig).toBeNull();
  });

  test('an unusable maxDelay is dropped so the default cap applies', () => {
    for (const maxDelay of [-1, MAX_BACKOFF_DELAY + 1, Number.POSITIVE_INFINITY, '2000', null]) {
      const job = parse({ type: 'fixed', delay: 60_000, maxDelay });
      expect(job.backoffConfig).toEqual({ type: 'fixed', delay: 60_000 });
      expect(calculateDelayedErrorDelay(job)).toBe(60_000);
    }
  });

  test('maxDelay 0 survives parsing', () => {
    const job = parse({ type: 'fixed', delay: 60_000, maxDelay: 0 });
    expect(job.backoffConfig).toEqual({ type: 'fixed', delay: 60_000, maxDelay: 0 });
    // Spec change: maxDelay 0 does not apply to DelayedError; a zero wait spins.
    expect(calculateDelayedErrorDelay(job)).toBe(60_000);
  });

  test('job.opts.backoff round-trips the object form for TCP workers', () => {
    const job = parse({ type: 'fixed', delay: 60_000, maxDelay: 2_000 });
    expect(buildJobOpts(job).backoff).toEqual({ type: 'fixed', delay: 60_000, maxDelay: 2_000 });
    expect(buildJobOpts(parse(null, 750)).backoff).toBe(750);
  });
});
