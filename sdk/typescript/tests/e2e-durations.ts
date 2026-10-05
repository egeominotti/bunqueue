/**
 * E2E: duration and count options of the legacy entry, on every runtime.
 *
 * Bun and Node.js arm a timer whose delay is NaN, negative or above 2^31 - 1 ms after
 * about 1 ms. These cases run the built package (dist/legacy.js) under Bun, Node and
 * Deno: invalid options throw where they enter with the main client's messages, and
 * long delays are honoured instead of firing at once. Values 0.2.2 handled correctly
 * keep 0.2.2's result (tests/e2e-legacy-compat.ts). The deterministic unit coverage
 * lives in tests/legacy-*.test.ts.
 */

import { createServer, type Socket } from 'node:net';
import {
  Bunqueue,
  Connection,
  ConnectionPool,
  Queue,
  type TelemetryEvent,
  Worker,
} from '../dist/legacy.js';
import { assert, assertEq, getPort, namedQueue, qname, sleep, test, waitFor } from './harness.ts';

const BEYOND_TIMER_LIMIT = 2 ** 31 + 1_000;

function throwsWith(fn: () => unknown, type: ErrorConstructor, message: string): void {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof type, `expected a ${type.name} containing "${message}"`);
  assert((error as Error).message.includes(message), `got "${(error as Error).message}"`);
}

test('durations: invalid connection, queue and pool options throw naming the option', async () => {
  throwsWith(
    () => new Connection({ commandTimeoutMs: Number.NaN }),
    RangeError,
    'Connection: commandTimeoutMs must be a finite number of milliseconds >= 1 or Infinity'
  );
  throwsWith(
    () => new Connection({ connectTimeoutMs: Number.POSITIVE_INFINITY }),
    RangeError,
    'Connection: connectTimeoutMs'
  );
  throwsWith(
    () => new Queue('q', { maxInFlight: Number.NaN }),
    RangeError,
    'Queue: maxInFlight must be a number of commands, 0 or below for unbounded (got NaN)'
  );
  throwsWith(
    () => new Queue('q', { poolSize: Number.POSITIVE_INFINITY }),
    RangeError,
    'Queue: poolSize'
  );
  throwsWith(() => new ConnectionPool(Number.NaN), RangeError, 'ConnectionPool: size');
});

test('durations: invalid worker and Simple Mode options throw before anything runs', async () => {
  const worker = (opts: Record<string, unknown>) => () =>
    new Worker('never', async () => 'ok', { autorun: false, ...opts });
  throwsWith(worker({ concurrency: Number.NaN }), RangeError, 'Worker: concurrency');
  throwsWith(worker({ pollTimeoutMs: 'soon' }), TypeError, 'Worker: pollTimeoutMs');
  throwsWith(worker({ lockTtlMs: 0 }), RangeError, 'Worker: lockTtlMs');
  throwsWith(worker({ concurrency: 'many' }), TypeError, 'Worker: concurrency');
  throwsWith(worker({ concurrency: 0 }), RangeError, 'concurrency must be >= 1');
  // sdk/CLAUDE.md rule 4: these clamp or disable instead of throwing.
  const clamped = new Worker('never', async () => 'ok', {
    autorun: false,
    heartbeatIntervalS: Number.NaN,
    pollTimeoutMs: -1,
    batchSize: Number.POSITIVE_INFINITY,
  });
  assertEq(clamped.heartbeatIntervalS, 0, 'a NaN heartbeat interval disables heartbeats');
  assertEq(clamped.pollTimeoutMs, 0, 'a negative poll timeout clamps to 0');
  assertEq(clamped.batchSize, 10, 'a non-finite batchSize falls back to 10');
  const app = (opts: Record<string, unknown>) => () =>
    new Bunqueue('never', { processor: async () => 'ok', autorun: false, ...opts });
  throwsWith(
    app({ priorityAging: { interval: 0 } }),
    RangeError,
    'Bunqueue: priorityAging.interval'
  );
  throwsWith(
    app({ circuitBreaker: { resetTimeout: 'soon' } }),
    TypeError,
    'Bunqueue: circuitBreaker.resetTimeout'
  );
  throwsWith(app({ rateLimit: { max: 0, duration: 1000 } }), RangeError, 'Bunqueue: rateLimit.max');
  throwsWith(app({ pollTimeout: 'soon' }), TypeError, 'Worker: pollTimeout');
});

test('durations: a commandTimeoutMs beyond the timer limit does not fire at once', async () => {
  const sockets: Socket[] = [];
  const silent = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  const port = (silent.address() as { port: number }).port;
  const conn = new Connection({ host: '127.0.0.1', port, commandTimeoutMs: BEYOND_TIMER_LIMIT });
  let outcome = 'pending';
  try {
    conn.call({ cmd: 'Ping' }).then(
      () => {
        outcome = 'resolved';
      },
      (error: Error) => {
        outcome = error.name;
      }
    );
    await sleep(150);
    assertEq(outcome, 'pending', 'a 24.8+ day command deadline must not expire after ~1 ms');
  } finally {
    conn.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
});

test('durations: an empty queue is not re-polled in a hot loop (PULLB per second)', async () => {
  const name = qname('poll-rate');
  const queue = namedQueue(name);
  // The main client's rule: 50 ms (drainDelay) after an empty pull with pollTimeoutMs 0,
  // 10 ms with a long poll. Ceilings leave room for slow CI; a hot loop does thousands.
  for (const [pollTimeoutMs, ceiling] of [
    [0, 40],
    [1, 120],
  ]) {
    let pulls = 0;
    const worker = new Worker(name, async () => 'ok', {
      host: '127.0.0.1',
      port: getPort(),
      pollTimeoutMs,
      heartbeatIntervalS: 0,
      onTelemetry: (event: TelemetryEvent) => {
        if (event.type === 'command' && event.cmd === 'PULLB') pulls += 1;
      },
    });
    worker.on('error', () => {});
    try {
      await worker.waitUntilReady();
      await sleep(100);
      const before = pulls;
      const started = Date.now();
      await sleep(1000);
      const perSecond = ((pulls - before) * 1000) / (Date.now() - started);
      assert(
        perSecond < ceiling,
        `pollTimeoutMs ${pollTimeoutMs}: ${Math.round(perSecond)} PULLB/s (ceiling ${ceiling})`
      );
      // An idle worker still picks a new job up promptly.
      const job = await queue.add('t', { pollTimeoutMs });
      await waitFor(async () => (await queue.getJobState(job.id)) === 'completed', 5000);
    } finally {
      await worker.close();
    }
  }
  await queue.obliterate();
  queue.close();
});

test('durations: a heartbeat period beyond the timer limit sends no Heartbeat flood', async () => {
  const name = qname('hb-long');
  const queue = namedQueue(name);
  let heartbeats = 0;
  const worker = new Worker(name, async () => 'ok', {
    host: '127.0.0.1',
    port: getPort(),
    pollTimeoutMs: 300,
    heartbeatIntervalS: 2_147_484, // 2_147_484_000 ms > 2^31 - 1 ms
    onTelemetry: (event: TelemetryEvent) => {
      if (event.type === 'command' && event.cmd === 'Heartbeat') heartbeats += 1;
    },
  });
  try {
    await worker.waitUntilReady();
    await queue.add('t', { x: 1 });
    await waitFor(async () => (await queue.getJobCounts()).completed >= 1, 15_000);
    await sleep(300); // a native interval would have fired hundreds of times by now
    assertEq(heartbeats, 0, 'no Heartbeat before the (24.8+ day) period elapses');
  } finally {
    await worker.close();
    await queue.obliterate();
    queue.close();
  }
});
