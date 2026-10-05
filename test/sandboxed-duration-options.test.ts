/**
 * SandboxedWorker validates every duration option in its constructor, before it
 * acquires a TCP pool or the shared embedded manager, and keeps the documented
 * meanings:
 *
 * - `timeout`, `idleTimeout`, `idleRecycleMs`: a finite number > 0, or disabled: `0`
 *   (documented), Infinity ("never"), and, as 2.9.10's `> 0` guards read them, a
 *   negative value or NaN.
 * - `heartbeatInterval`: a non-positive number disables (documented); otherwise a
 *   finite number >= 1.
 * - `pollInterval`, `autoStartPollMs`: a finite number >= 1.
 *
 * A non-number (a numeric string is that number), NaN or an infinite period and a
 * sub-millisecond period (below timer resolution: Bun.sleep resolves it at once, a
 * native interval spins at ~1 ms) throw, naming the option and the value.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { SandboxedWorker } from '../src/client/sandboxed';
import { SandboxedProbe, fakeBroker, type ProbeOptions } from './sandboxed-timers-support';

type Option =
  | 'timeout'
  | 'idleTimeout'
  | 'idleRecycleMs'
  | 'heartbeatInterval'
  | 'pollInterval'
  | 'autoStartPollMs';

const LONG = 3_000_000_000;
const probes: SandboxedProbe[] = [];

afterEach(async () => {
  for (const probe of probes.splice(0)) await probe.stop(true);
});

function create(option: Option, value: unknown): SandboxedProbe {
  const { manager } = fakeBroker();
  const probe = new SandboxedProbe({ manager, [option]: value } as ProbeOptions);
  probes.push(probe);
  return probe;
}

/** Every resolved duration, read through the protected runtime fields. */
function durations(probe: SandboxedProbe): Record<Option, number> {
  const fields = probe as unknown as {
    options: { timeout: number; pollInterval: number };
    heartbeatInterval: number;
    idleTimeout: number;
    idleRecycleMs: number;
    autoStartPollMs: number;
  };
  return {
    timeout: fields.options.timeout,
    idleTimeout: fields.idleTimeout,
    idleRecycleMs: fields.idleRecycleMs,
    heartbeatInterval: fields.heartbeatInterval,
    pollInterval: fields.options.pollInterval,
    autoStartPollMs: fields.autoStartPollMs,
  };
}

const NEVER_OPTIONS: Option[] = ['timeout', 'idleTimeout', 'idleRecycleMs'];
const PERIOD_OPTIONS: Option[] = ['pollInterval', 'autoStartPollMs'];

const REJECTED: Array<[Option, unknown, typeof TypeError | typeof RangeError]> = [
  ...NEVER_OPTIONS.flatMap((option): Array<[Option, unknown, typeof TypeError]> => [
    [option, 'soon', TypeError],
    [option, {}, TypeError],
  ]),
  ['heartbeatInterval', NaN, RangeError],
  ['heartbeatInterval', Infinity, RangeError],
  ['heartbeatInterval', 0.5, RangeError],
  ['heartbeatInterval', 'often', TypeError],
  ['heartbeatInterval', '-1', TypeError],
  ...PERIOD_OPTIONS.flatMap((option): Array<[Option, unknown, typeof RangeError]> => [
    [option, NaN, RangeError],
    [option, 0, RangeError],
    [option, -1, RangeError],
    [option, 0.5, RangeError],
    [option, Infinity, RangeError],
    [option, -Infinity, RangeError],
    [option, 'often', TypeError],
  ]),
];

describe('SandboxedWorker duration options', () => {
  test.each(REJECTED)('%s = %p throws %p naming the option', (option, value, kind) => {
    expect(() => create(option, value)).toThrow(kind);
    expect(() => create(option, value)).toThrow(`SandboxedWorker: ${option} must be`);
  });

  test('the messages state the accepted range and the received value', () => {
    expect(() => create('timeout', 'soon')).toThrow(
      'SandboxedWorker: timeout must be a finite number of milliseconds >= 0 (got "soon")'
    );
    expect(() => create('idleRecycleMs', 'later')).toThrow(
      'SandboxedWorker: idleRecycleMs must be a finite number of milliseconds >= 0 (got "later")'
    );
    expect(() => create('heartbeatInterval', NaN)).toThrow(
      'SandboxedWorker: heartbeatInterval must be a finite number of milliseconds >= 1 (got NaN)'
    );
    expect(() => create('pollInterval', 0)).toThrow(
      'SandboxedWorker: pollInterval must be a finite number of milliseconds >= 1 (got 0)'
    );
    expect(() => create('autoStartPollMs', 'often')).toThrow(
      'SandboxedWorker: autoStartPollMs must be a finite number of milliseconds >= 1 (got "often")'
    );
  });

  test('the documented defaults are unchanged (embedded)', () => {
    const { manager } = fakeBroker();
    const probe = new SandboxedProbe({ manager });
    probes.push(probe);
    expect(durations(probe)).toEqual({
      timeout: 30_000,
      idleTimeout: 0,
      idleRecycleMs: 30_000,
      heartbeatInterval: 5_000,
      pollInterval: 10,
      autoStartPollMs: 5_000,
    });
  });

  test('null and undefined select the default, as before', () => {
    expect(durations(create('timeout', undefined)).timeout).toBe(30_000);
    expect(durations(create('pollInterval', null)).pollInterval).toBe(10);
  });

  test.each(NEVER_OPTIONS)('%s accepts 0, fractions, long values and Infinity', (option) => {
    for (const value of [0, 0.5, 250, LONG]) {
      expect(durations(create(option, value))[option]).toBe(value);
    }
    // Infinity means "never": stored as 0, the documented "disabled". So are a negative
    // value and NaN, which 2.9.10's `> 0` guards read as disabled; a numeric string is
    // that number.
    for (const value of [Infinity, -1, -Infinity, NaN]) {
      expect(durations(create(option, value))[option]).toBe(0);
    }
    expect(durations(create(option, '1000'))[option]).toBe(1000);
  });

  test('heartbeatInterval keeps "non-positive disables" and accepts long periods', () => {
    for (const value of [0, -1, -0.5, -Infinity]) {
      expect(durations(create('heartbeatInterval', value)).heartbeatInterval).toBe(0);
    }
    for (const value of [1, 1.5, 10_000, LONG]) {
      expect(durations(create('heartbeatInterval', value)).heartbeatInterval).toBe(value);
    }
  });

  test.each(PERIOD_OPTIONS)('%s accepts any finite period of at least 1 ms', (option) => {
    for (const value of [1, 1.5, 10, LONG]) {
      expect(durations(create(option, value))[option]).toBe(value);
    }
  });

  test('validation runs before a TCP pool is acquired', () => {
    const touched: string[] = [];
    const connection = new Proxy(
      {},
      {
        get: (_target, key) => {
          touched.push(String(key));
          return undefined;
        },
      }
    );
    expect(
      () =>
        new SandboxedWorker('sandboxed-tcp', { processor: '/p.mjs', connection, pollInterval: NaN })
    ).toThrow(RangeError);
    expect(touched).toEqual([]);
  });
});
