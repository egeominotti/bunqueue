/**
 * Legacy entry: Worker durations and counts.
 *
 * A heartbeat period above 2^31 - 1 ms used to tick every millisecond, a NaN poll
 * timeout made every PULLB time out at once, and NaN counts slipped past the `< 1`
 * guard. The Worker now validates its options in the constructor with the main
 * client's rules and arms its heartbeat with `safeInterval`. Values 0.2.2 handled
 * correctly keep 0.2.2's result: see legacy-compat-options.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import type { Connection } from '../src/connection.js';
import { Worker } from '../src/worker.js';
import type { WorkerOptions } from '../src/worker-types.js';

const processor = async () => 'ok';

function make(opts: WorkerOptions): Worker {
  return new Worker('durations', processor, { autorun: false, ...opts });
}

/**
 * Replace the worker's connection with an in-memory broker that never has jobs. An
 * empty PULLB answers after `pullDelayMs`, or on the next macrotask when 0 (as a socket
 * reply would), so a loop without a pause spins instead of blocking the test.
 */
function stubBroker(worker: Worker, pullDelayMs = 10): string[] {
  const commands: string[] = [];
  (worker.connection as unknown as { call: Connection['call'] }).call = (async (command: {
    cmd: string;
  }) => {
    commands.push(command.cmd);
    if (command.cmd === 'PULLB') {
      await new Promise((resolve) =>
        pullDelayMs > 0 ? setTimeout(resolve, pullDelayMs) : setImmediate(resolve)
      );
      return { ok: true, jobs: [], tokens: [] };
    }
    return { ok: true };
  }) as Connection['call'];
  return commands;
}

describe('legacy Worker option validation', () => {
  test('concurrency must be a positive whole number', () => {
    for (const value of [Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => make({ concurrency: value })).toThrow(
        'Worker: concurrency must be a whole number >= 1'
      );
    }
    // Below 1 keeps 0.2.2's message; a numeric string is its number.
    for (const value of [0, -1]) {
      expect(() => make({ concurrency: value })).toThrow('Worker: concurrency must be >= 1');
    }
    expect(() => make({ concurrency: 'many' as unknown as number })).toThrow(TypeError);
    expect(make({ concurrency: '4' as unknown as number }).concurrency).toBe(4);
  });

  // sdk/CLAUDE.md rule 4: batchSize clamps to [1, 1000] with a finite guard (the 0.1.x
  // behaviour: a non-finite or non-number value means the default, 10). Never throws.
  test('batchSize: clamped to [1, 1000], non-finite falls back to 10', () => {
    expect(make({ batchSize: 0 }).batchSize).toBe(1);
    expect(make({ batchSize: -7 }).batchSize).toBe(1);
    expect(make({ batchSize: 5000 }).batchSize).toBe(1000);
    expect(make({ batchSize: 2.5 }).batchSize).toBe(2.5);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(make({ batchSize: value }).batchSize).toBe(10);
    }
    expect(make({}).batchSize).toBe(10);
    expect(make({ batchSize: '5' as unknown as number }).batchSize).toBe(10);
  });

  // Rule 4 pins poll timeout <= 30000 and the spec makes clients clamp to what the
  // broker accepts ([0, 60000]): NaN, which used to wedge the pull loop, means the default.
  test('pollTimeoutMs: clamped to [0, 30000], NaN falls back to 5000', () => {
    expect(make({ pollTimeoutMs: Number.POSITIVE_INFINITY }).pollTimeoutMs).toBe(30_000);
    expect(make({ pollTimeoutMs: 45_000 }).pollTimeoutMs).toBe(30_000);
    expect(make({ pollTimeoutMs: 0 }).pollTimeoutMs).toBe(0);
    expect(make({ pollTimeoutMs: -1 }).pollTimeoutMs).toBe(0);
    expect(make({ pollTimeoutMs: Number.NEGATIVE_INFINITY }).pollTimeoutMs).toBe(0);
    expect(make({ pollTimeoutMs: Number.NaN }).pollTimeoutMs).toBe(5000);
    expect(make({ pollTimeoutMs: '100' as unknown as number }).pollTimeoutMs).toBe(100);
    expect(() => make({ pollTimeoutMs: 'soon' as unknown as number })).toThrow(
      'Worker: pollTimeoutMs must be a number (got "soon")'
    );
  });

  test('lockTtlMs is a lease TTL: finite and at least 1 ms', () => {
    for (const value of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      expect(() => make({ lockTtlMs: value })).toThrow(
        'Worker: lockTtlMs must be a finite number of milliseconds >= 1'
      );
    }
    expect(make({ lockTtlMs: 3_000_000_000 }).lockTtlMs).toBe(3_000_000_000);
  });

  // Protocol spec section 6.3 and sdk/CLAUDE.md rule 4: 0, negative and non-finite
  // intervals disable heartbeats at the SDK surface, and so does a non-number (0.2.2's
  // finite guard). The interval never throws.
  test('heartbeatIntervalS: 0, negative, non-finite and non-number disable heartbeats', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(make({ heartbeatIntervalS: value }).heartbeatIntervalS).toBe(0);
    }
    expect(make({ heartbeatIntervalS: 2_147_484 }).heartbeatIntervalS).toBe(2_147_484);
    expect(make({ heartbeatIntervalS: '10' as unknown as number }).heartbeatIntervalS).toBe(0);
  });

  test('ackBatch.maxDelayMs: an infinite or non-numeric delay throws when batching is on', () => {
    expect(() =>
      make({ ackBatch: { enabled: true, maxDelayMs: Number.POSITIVE_INFINITY } })
    ).toThrow('Worker: ackBatch.maxDelayMs must be a finite number of milliseconds (got Infinity)');
    expect(() =>
      make({ ackBatch: { enabled: true, maxDelayMs: 'soon' as unknown as number } })
    ).toThrow(TypeError);
    // 0.2.2: NaN or a negative delay flushes on the next tick; maxSize 0 sends at once.
    for (const maxDelayMs of [Number.NaN, -1]) {
      expect(() => make({ ackBatch: { enabled: true, maxSize: 0, maxDelayMs } })).not.toThrow();
    }
    expect(() =>
      make({ ackBatch: { enabled: false, maxDelayMs: Number.POSITIVE_INFINITY } })
    ).not.toThrow();
  });
});

describe('legacy Worker heartbeat timer', () => {
  test('a NaN or infinite heartbeat interval sends no Heartbeat (disabled, not a spin)', async () => {
    for (const heartbeatIntervalS of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      const worker = make({ heartbeatIntervalS, pollTimeoutMs: 0 });
      const commands = stubBroker(worker);
      worker.run();
      try {
        await worker.waitUntilReady();
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(commands.filter((cmd) => cmd === 'Heartbeat')).toHaveLength(0);
      } finally {
        await worker.close(true);
      }
    }
  });

  test('a heartbeat period beyond the timer limit does not tick every millisecond', async () => {
    // 2_147_484 s = 2_147_484_000 ms, just above 2^31 - 1 ms.
    const worker = make({ heartbeatIntervalS: 2_147_484, pollTimeoutMs: 0 });
    const commands = stubBroker(worker);
    worker.run();
    try {
      await worker.waitUntilReady();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(commands.filter((cmd) => cmd === 'Heartbeat')).toHaveLength(0);
    } finally {
      await worker.close(true);
    }
  });

  test('a short heartbeat period still beats', async () => {
    const worker = make({ heartbeatIntervalS: 0.02, pollTimeoutMs: 0 });
    const commands = stubBroker(worker);
    worker.run();
    try {
      await worker.waitUntilReady();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const beats = commands.filter((cmd) => cmd === 'Heartbeat').length;
      expect(beats).toBeGreaterThanOrEqual(2);
      expect(beats).toBeLessThan(20);
    } finally {
      await worker.close(true);
    }
  });
});

describe('legacy Worker empty-pull pacing', () => {
  test('after an empty pull: 50 ms with pollTimeoutMs 0, 10 ms with a long poll', async () => {
    for (const [pollTimeoutMs, ceiling] of [
      [0, 8], // 200 ms / 50 ms, plus the first pull
      [1, 30], // 200 ms / 10 ms, plus slack
    ]) {
      const worker = make({ pollTimeoutMs, heartbeatIntervalS: 0 });
      const commands = stubBroker(worker, 0);
      worker.run();
      try {
        await worker.waitUntilReady();
        await new Promise((resolve) => setTimeout(resolve, 200));
        const pulls = commands.filter((cmd) => cmd === 'PULLB').length;
        expect(pulls).toBeGreaterThanOrEqual(2);
        expect(pulls).toBeLessThanOrEqual(ceiling);
      } finally {
        await worker.close(true);
      }
    }
  });
});
