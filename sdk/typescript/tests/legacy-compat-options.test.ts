/**
 * Legacy entry: 0.2.2 compatibility of the Connection, ConnectionPool, Queue and
 * Worker options.
 *
 * 0.2.3 validates options where they enter. A value that 0.2.2 handled without a hot
 * loop, a hang or an immediate timeout must keep 0.2.2's result: a negative
 * `maxInFlight` is unbounded, a fractional pool size is floored, a numeric string is
 * read as its number where 0.2.2's arithmetic or timers did so, and `null` keeps
 * 0.2.2's meaning. Each expectation was verified against the 0.2.2 sources.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server, type Socket } from 'node:net';
import { Connection } from '../src/connection.js';
import { ConnectionPool } from '../src/connection-pool.js';
import { CommandTimeoutError } from '../src/errors.js';
import { Queue } from '../src/queue.js';
import { Worker } from '../src/worker.js';
import type { WorkerOptions } from '../src/worker-types.js';

const asNumber = (value: unknown) => value as number;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Whether the in-flight gate admits a command when `inFlight` are pending. */
function admits(conn: Connection, inFlight: number): boolean {
  const gate = (conn as unknown as { backpressure: { acquire(n: number): unknown } }).backpressure;
  return gate.acquire(inFlight) === undefined;
}

let silent: Server;
let silentPort = 0;
const sockets: Socket[] = [];

beforeAll(async () => {
  silent = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  silentPort = (silent.address() as { port: number }).port;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => silent.close(() => resolve()));
});

describe('0.2.2 compatibility: Connection', () => {
  test('a negative maxInFlight (or -Infinity) is unbounded, as 0 is', () => {
    for (const maxInFlight of [-1, -50, Number.NEGATIVE_INFINITY]) {
      expect(admits(new Connection({ maxInFlight }), 10_000)).toBe(true);
    }
  });

  test('a fractional, huge or numeric-string maxInFlight gates as 0.2.2 compared it', () => {
    const fraction = new Connection({ maxInFlight: 2.5 });
    expect([admits(fraction, 2), admits(fraction, 3)]).toEqual([true, false]);
    const text = new Connection({ maxInFlight: asNumber('5') });
    expect([admits(text, 4), admits(text, 5)]).toEqual([true, false]);
    expect(admits(new Connection({ maxInFlight: 1e300 }), 1e6)).toBe(true);
  });

  test('a numeric-string connect or command timeout is read as its number', () => {
    const conn = new Connection({
      connectTimeoutMs: asNumber('250'),
      commandTimeoutMs: asNumber('5000'),
    });
    expect(Number(conn.connectTimeoutMs)).toBe(250);
    expect(Number(conn.commandTimeoutMs)).toBe(5000);
  });

  test('a numeric-string per-call timeout still times the command out', async () => {
    const conn = new Connection({ host: '127.0.0.1', port: silentPort });
    try {
      const error = await conn.call({ cmd: 'Ping' }, asNumber('20')).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CommandTimeoutError);
    } finally {
      conn.close();
    }
  });
});

describe('0.2.2 compatibility: ConnectionPool and Queue', () => {
  test('a pool size is floored and read as a number; below 1 is one connection', () => {
    expect(new ConnectionPool(2.5).size).toBe(2);
    expect(new ConnectionPool(asNumber('4')).size).toBe(4);
    expect(new ConnectionPool(asNumber(null)).size).toBe(1);
    expect(new ConnectionPool(-2.5).size).toBe(1);
    expect(new ConnectionPool(Number.NEGATIVE_INFINITY).size).toBe(1);
  });

  test('Queue builds a pool only for a truthy poolSize above 1, as 0.2.2 did', () => {
    const shape = (poolSize: unknown) => {
      const conn = new Queue('q', { poolSize: asNumber(poolSize) }).connection;
      return conn instanceof ConnectionPool ? `pool/${conn.size}` : 'single';
    };
    expect(shape(Number.NaN)).toBe('single');
    expect(shape('abc')).toBe('single');
    expect(shape(1.5)).toBe('pool/1');
    expect(shape('4')).toBe('pool/4');
    expect(shape(0)).toBe('single');
  });

  test('Queue ignores options it never forwards, and every option with its own connection', () => {
    // connectTimeoutMs is not a Queue option: 0.2.2 never read it.
    expect(() => new Queue('q', { connectTimeoutMs: 0 } as never)).not.toThrow();
    const own = new Connection();
    const queue = new Queue('q', {
      connection: own,
      commandTimeoutMs: 0,
      maxInFlight: Number.NaN,
      poolSize: Number.NaN,
    });
    expect(queue.connection).toBe(own);
  });

  test('waitForJob: null is a zero hold and a numeric string its number', async () => {
    const calls: unknown[][] = [];
    const connection = {
      async call(command: Record<string, unknown>, timeoutMs?: number) {
        calls.push([command.timeout, timeoutMs]);
        return { ok: true, completed: true, result: 'done' };
      },
    };
    const queue = new Queue('wait', { connection: connection as unknown as Connection });
    await queue.waitForJob('a', asNumber(null));
    await queue.waitForJob('b', asNumber('5000'));
    await queue.waitJobUntilFinished('c', undefined, asNumber(null));
    expect(calls).toEqual([
      [0, 5000],
      [5000, 10_000],
      [0, 5000],
    ]);
  });
});

describe('0.2.2 compatibility: Worker', () => {
  const make = (opts: WorkerOptions) => new Worker('compat', async () => 'ok', opts);

  /** An in-memory broker: the first PULLB hands out `jobs` jobs, then none. */
  function stubBroker(worker: Worker, jobs: number) {
    const commands: Array<Record<string, unknown>> = [];
    let handed = false;
    (worker.connection as unknown as { call: Connection['call'] }).call = (async (
      command: Record<string, unknown>
    ) => {
      commands.push(command);
      if (command.cmd !== 'PULLB') return { ok: true };
      await sleep(2);
      if (handed) return { ok: true, jobs: [], tokens: [] };
      handed = true;
      const ids = Array.from({ length: jobs }, (_, i) => `job-${i}`);
      return { ok: true, jobs: ids.map((id) => ({ id, data: {} })), tokens: ids };
    }) as Connection['call'];
    return commands;
  }

  test('numeric-string concurrency and pollTimeoutMs are read as numbers', async () => {
    const worker = make({
      autorun: false,
      concurrency: asNumber('4'),
      pollTimeoutMs: asNumber('5000'),
    });
    expect(Number(worker.concurrency)).toBe(4);
    expect(worker.pollTimeoutMs).toBe(5000);
    const commands = stubBroker(worker, 0);
    worker.run();
    try {
      await worker.waitUntilReady();
      await sleep(20);
      const pull = commands.find((command) => command.cmd === 'PULLB');
      expect(pull?.count).toBe(4);
    } finally {
      await worker.close(true);
    }
  });

  test('concurrency below 1 still throws with the 0.2.2 message', () => {
    for (const concurrency of [0, -1, asNumber('0')]) {
      expect(() => make({ autorun: false, concurrency })).toThrow('concurrency must be >= 1');
    }
  });

  test('a non-number batchSize means 10 and a non-number heartbeat disables heartbeats', async () => {
    const worker = make({
      autorun: false,
      pollTimeoutMs: 0,
      batchSize: asNumber('5'),
      heartbeatIntervalS: asNumber('0.01'),
    });
    expect(worker.batchSize).toBe(10);
    const commands = stubBroker(worker, 0);
    worker.run();
    try {
      await worker.waitUntilReady();
      await sleep(60);
      expect(commands.filter((command) => command.cmd === 'Heartbeat')).toHaveLength(0);
    } finally {
      await worker.close(true);
    }
  });

  test('ackBatch: maxSize 0 sends every ACK at once; a negative maxDelayMs flushes at once', async () => {
    for (const ackBatch of [
      { enabled: true, maxSize: 0, maxDelayMs: 10_000 },
      { enabled: true, maxSize: 50, maxDelayMs: -1 },
      { enabled: true, maxSize: 50, maxDelayMs: Number.NaN },
      { enabled: true, maxSize: asNumber('1'), maxDelayMs: asNumber('10000') },
    ]) {
      const worker = make({ autorun: false, heartbeatIntervalS: 0, ackBatch });
      const commands = stubBroker(worker, 2);
      worker.run();
      try {
        await worker.waitUntilReady();
        await sleep(40);
        const acked = commands
          .filter((command) => command.cmd === 'ACKB')
          .flatMap((command) => command.ids as string[]);
        expect(acked.sort()).toEqual(['job-0', 'job-1']);
      } finally {
        await worker.close(true);
      }
    }
  });
});
