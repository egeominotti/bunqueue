/**
 * Repro (2.9.10 compatibility): SandboxedWorker and Queue `autoBatch` options that
 * 2.9.10 accepted with a well-defined result must keep that result. The 2.9.11
 * candidate threw for them:
 *
 * - SandboxedWorker `concurrency: 0` started 1 thread and `2.5` started 3 (start()
 *   spawns slot 0, then `for (i = 1; i < concurrency; i++)`);
 * - `timeout`, `idleTimeout` and `idleRecycleMs` at -1 (or NaN) were disabled: every
 *   one is guarded by `> 0`;
 * - numeric strings read as numbers (the timers coerce them);
 * - `autoBatch.maxSize: 0` flushed every add at once (`length >= 0`), as 1 does, 2.5
 *   flushed at 3 and Infinity or NaN never flushed by size; `maxDelayMs` -1 or NaN
 *   waited no time;
 * - `autoBatch.enabled` that is not a boolean left batching on.
 *
 * Still rejected: SandboxedWorker `concurrency: Infinity` (endless spawning) or NaN,
 * a NaN heartbeatInterval or a sub-millisecond poll period (a ~1 ms spin). No
 * `autoBatch` value throws (test/repro-compat-client-pull-quiet.test.ts).
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Queue } from '../src/client';
import { resolveAutoBatchConfig } from '../src/client/queue/addBatcher';
import {
  resolveConcurrency,
  resolveSandboxedDurations,
} from '../src/client/sandboxed/runtime/options';
import { SandboxedProbe, fakeBroker, type ProbeOptions } from './sandboxed-timers-support';
import { cleanup, closedPort } from './tcp-client-support';

const probes: SandboxedProbe[] = [];
const queues: Queue[] = [];

afterEach(async () => {
  for (const probe of probes.splice(0)) await probe.stop(true);
  for (const queue of queues.splice(0)) await queue.close();
  cleanup();
});

function probe(options: Partial<ProbeOptions>): SandboxedProbe {
  const { manager } = fakeBroker();
  const created = new SandboxedProbe({ manager, ...options } as ProbeOptions);
  probes.push(created);
  return created;
}

const asNumber = (value: string) => value as unknown as number;

describe('SandboxedWorker concurrency keeps its 2.9.10 thread count', () => {
  test('0 and -1 start 1 thread, 2.5 starts 3, "2" starts 2', () => {
    expect(resolveConcurrency(0)).toBe(1);
    expect(resolveConcurrency(-1)).toBe(1);
    expect(resolveConcurrency(2.5)).toBe(3);
    expect(resolveConcurrency(asNumber('2'))).toBe(2);
  });

  test('the constructor accepts them', () => {
    for (const concurrency of [0, 2.5, -1]) {
      const created = probe({ concurrency });
      const options = (created as unknown as { options: { concurrency: number } }).options;
      expect(options.concurrency).toBe(Math.max(1, Math.ceil(concurrency)));
    }
  });

  test('Infinity and NaN still throw', () => {
    expect(() => resolveConcurrency(Infinity)).toThrow('SandboxedWorker: concurrency must be');
    expect(() => resolveConcurrency(NaN)).toThrow('SandboxedWorker: concurrency must be');
  });
});

describe('SandboxedWorker "after this many ms" options', () => {
  test('-1 and NaN disable timeout, idleTimeout and idleRecycleMs, as 0 does', () => {
    for (const value of [-1, NaN, -Infinity]) {
      const resolved = resolveSandboxedDurations(
        { processor: 'p.ts', timeout: value, idleTimeout: value, idleRecycleMs: value },
        false
      );
      expect(resolved.timeout).toBe(0);
      expect(resolved.idleTimeout).toBe(0);
      expect(resolved.idleRecycleMs).toBe(0);
    }
    expect(() => probe({ idleTimeout: -1, idleRecycleMs: -1, timeout: -1 })).not.toThrow();
  });

  test('numeric strings read as numbers', () => {
    const resolved = resolveSandboxedDurations(
      {
        processor: 'p.ts',
        timeout: asNumber('1000'),
        idleTimeout: asNumber('5000'),
        heartbeatInterval: asNumber('2000'),
        pollInterval: asNumber('10'),
      },
      false
    );
    expect(resolved.timeout).toBe(1000);
    expect(resolved.idleTimeout).toBe(5000);
    expect(resolved.heartbeatInterval).toBe(2000);
    expect(resolved.pollInterval).toBe(10);
  });

  test('a NaN heartbeat and a sub-millisecond poll still throw (a ~1 ms spin)', () => {
    expect(() => probe({ heartbeatInterval: NaN })).toThrow('SandboxedWorker: heartbeatInterval');
    expect(() => probe({ pollInterval: 0 })).toThrow('SandboxedWorker: pollInterval');
  });
});

describe('Queue autoBatch keeps its 2.9.10 results', () => {
  test('maxSize 0 and -1 flush every add (as 1), 2.5 flushes at 3, Infinity is kept', () => {
    expect(resolveAutoBatchConfig({ maxSize: 0 })?.maxSize).toBe(1);
    expect(resolveAutoBatchConfig({ maxSize: -1 })?.maxSize).toBe(1);
    expect(resolveAutoBatchConfig({ maxSize: 2.5 })?.maxSize).toBe(3);
    expect(resolveAutoBatchConfig({ maxSize: Infinity })?.maxSize).toBe(Infinity);
    expect(resolveAutoBatchConfig({ maxSize: asNumber('20') })?.maxSize).toBe(20);
  });

  test('maxDelayMs -1 waits no time', () => {
    expect(resolveAutoBatchConfig({ maxDelayMs: -1 })?.maxDelayMs).toBe(0);
    expect(resolveAutoBatchConfig({ maxDelayMs: asNumber('7') })?.maxDelayMs).toBe(7);
  });

  test('NaN, Infinity and non-numbers act as 2.9.10 read them', () => {
    // `pending >= NaN` never flushed by size; a NaN or infinite window ran after ~1 ms.
    expect(resolveAutoBatchConfig({ maxSize: NaN })?.maxSize).toBe(Infinity);
    expect(resolveAutoBatchConfig({ maxSize: 1e20 })?.maxSize).toBe(Infinity);
    expect(resolveAutoBatchConfig({ maxSize: 'big' as never })?.maxSize).toBe(Infinity);
    expect(resolveAutoBatchConfig({ maxDelayMs: NaN })?.maxDelayMs).toBe(0);
    expect(resolveAutoBatchConfig({ maxDelayMs: Infinity })?.maxDelayMs).toBe(0);
  });

  test('enabled: recognized words and numbers take their meaning', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const off of ['false', 0, '0', ' FALSE ']) {
        expect(resolveAutoBatchConfig({ enabled: off as never })).toBeNull();
      }
      for (const on of ['true', 1, '1', null]) {
        expect(resolveAutoBatchConfig({ enabled: on as never })).not.toBeNull();
      }
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('enabled: anything else warns once and keeps batching on (the 2.9.10 result)', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveAutoBatchConfig({ enabled: 'yes' as never })).not.toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('autoBatch.enabled');
    } finally {
      warn.mockRestore();
    }
  });

  test('a TCP Queue accepts each of them', () => {
    const connection = { host: '127.0.0.1', port: closedPort() };
    for (const autoBatch of [
      { maxSize: 0 },
      { maxSize: Infinity },
      { maxDelayMs: -1 },
      { enabled: 0 },
    ]) {
      queues.push(
        new Queue('compat-autobatch', {
          embedded: false,
          connection,
          autoBatch: autoBatch as never,
        })
      );
    }
  });
});
