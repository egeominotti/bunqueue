/**
 * Legacy entry: connection-level durations and counts.
 *
 * Bun and Node.js arm a timer whose delay is NaN, negative or above 2^31 - 1 ms after
 * about 1 ms. These tests pin that the legacy Connection, ConnectionPool and Queue
 * reject such values where they enter, with the main client's messages, and honour
 * long delays instead of firing at once. Values 0.2.2 handled correctly keep 0.2.2's
 * result: see legacy-compat-options.test.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server, type Socket } from 'node:net';
import { Connection } from '../src/connection.js';
import { ConnectionPool } from '../src/connection-pool.js';
import { CommandTimeoutError, ConnectionClosedError } from '../src/errors.js';
import { Queue } from '../src/queue.js';

const BEYOND_TIMER_LIMIT = 2 ** 31 + 1_000;

/** A broker stand-in that accepts connections and never answers. */
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

/** Settle state of a promise after `ms`, without awaiting it to completion. */
async function stateAfter(promise: Promise<unknown>, ms: number): Promise<string> {
  let state = 'pending';
  promise.then(
    () => {
      state = 'resolved';
    },
    (error: unknown) => {
      state = error instanceof Error ? error.constructor.name : 'rejected';
    }
  );
  await new Promise((resolve) => setTimeout(resolve, ms));
  return state;
}

describe('legacy Connection options', () => {
  test('rejects a NaN, zero or negative commandTimeoutMs, naming the option', () => {
    for (const value of [Number.NaN, 0, -1, Number.NEGATIVE_INFINITY]) {
      expect(() => new Connection({ commandTimeoutMs: value })).toThrow(
        'Connection: commandTimeoutMs must be a finite number of milliseconds >= 1 or Infinity'
      );
    }
    // A numeric string is its number (0.2.2's setTimeout read it so); any other throws.
    expect(() => new Connection({ commandTimeoutMs: 'soon' as unknown as number })).toThrow(
      TypeError
    );
  });

  test('rejects a NaN, zero or infinite connectTimeoutMs', () => {
    for (const value of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      expect(() => new Connection({ connectTimeoutMs: value })).toThrow(
        'Connection: connectTimeoutMs must be a finite number of milliseconds >= 1'
      );
    }
  });

  test('rejects a maxInFlight that would park every command (NaN or not a number)', () => {
    expect(() => new Connection({ maxInFlight: Number.NaN })).toThrow(
      'Connection: maxInFlight must be a number of commands, 0 or below for unbounded (got NaN)'
    );
    expect(() => new Connection({ maxInFlight: 'many' as unknown as number })).toThrow(TypeError);
    // 0 and below keep their 0.2.2 meaning (unbounded), Infinity is unbounded too.
    for (const value of [0, -1, Number.POSITIVE_INFINITY]) {
      expect(() => new Connection({ maxInFlight: value })).not.toThrow();
    }
  });

  test('undefined and null keep the defaults', () => {
    const conn = new Connection({
      commandTimeoutMs: undefined,
      connectTimeoutMs: null as unknown as number,
    });
    expect(conn.commandTimeoutMs).toBe(10_000);
    expect(conn.connectTimeoutMs).toBe(5000);
  });

  test('a commandTimeoutMs beyond the timer limit does not time out after ~1 ms', async () => {
    const conn = new Connection({
      host: '127.0.0.1',
      port: silentPort,
      commandTimeoutMs: BEYOND_TIMER_LIMIT,
    });
    try {
      const reply = conn.call({ cmd: 'Ping' });
      expect(await stateAfter(reply, 80)).toBe('pending');
      conn.close();
      expect(await stateAfter(reply, 0)).toBe(ConnectionClosedError.name);
    } finally {
      conn.close();
    }
  });

  test('commandTimeoutMs: Infinity means no client-side deadline', async () => {
    const conn = new Connection({
      host: '127.0.0.1',
      port: silentPort,
      commandTimeoutMs: Number.POSITIVE_INFINITY,
    });
    try {
      const reply = conn.call({ cmd: 'Ping' });
      expect(await stateAfter(reply, 80)).toBe('pending');
    } finally {
      conn.close();
    }
  });

  test('a finite commandTimeoutMs still times out', async () => {
    const conn = new Connection({ host: '127.0.0.1', port: silentPort, commandTimeoutMs: 20 });
    try {
      expect(await stateAfter(conn.call({ cmd: 'Ping' }), 150)).toBe(CommandTimeoutError.name);
    } finally {
      conn.close();
    }
  });

  test('call() rejects an invalid per-call timeout instead of timing out at once', async () => {
    const conn = new Connection({ host: '127.0.0.1', port: silentPort });
    try {
      for (const value of [Number.NaN, 0, -1]) {
        await expect(conn.call({ cmd: 'Ping' }, value)).rejects.toThrow(
          'Connection: call() timeoutMs must be a finite number of milliseconds >= 1 or Infinity'
        );
      }
    } finally {
      conn.close();
    }
  });
});

describe('legacy ConnectionPool and Queue options', () => {
  test('ConnectionPool rejects a NaN, infinite or oversized size', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 70_000]) {
      expect(() => new ConnectionPool(value)).toThrow(
        'ConnectionPool: size must be a number of connections up to 65535'
      );
    }
    // Floored as in 0.2.2; below 1 still means one connection.
    expect(new ConnectionPool(2.5).size).toBe(2);
    expect(new ConnectionPool(0).size).toBe(1);
    expect(new ConnectionPool(-3).size).toBe(1);
  });

  test('ConnectionPool validates the member connection options once, with its own name', () => {
    expect(() => new ConnectionPool(2, { commandTimeoutMs: Number.NaN })).toThrow(
      'ConnectionPool: commandTimeoutMs'
    );
  });

  test('Queue validates poolSize, commandTimeoutMs and maxInFlight with its own name', () => {
    expect(() => new Queue('q', { poolSize: Number.POSITIVE_INFINITY })).toThrow(
      'Queue: poolSize must be a number of connections up to 65535'
    );
    expect(() => new Queue('q', { commandTimeoutMs: -1 })).toThrow(
      'Queue: commandTimeoutMs must be a finite number of milliseconds >= 1 or Infinity'
    );
    expect(() => new Queue('q', { maxInFlight: Number.NaN })).toThrow(
      'Queue: maxInFlight must be a number of commands'
    );
    expect(() => new Queue('q', { poolSize: 3 })).not.toThrow();
  });
});

describe('legacy Queue.waitForJob ttl', () => {
  function recordingQueue() {
    const calls: Array<{ command: Record<string, unknown>; timeoutMs?: number }> = [];
    const connection = {
      async call(command: Record<string, unknown>, timeoutMs?: number) {
        calls.push({ command, timeoutMs });
        return command.cmd === 'WaitJob'
          ? { ok: true, completed: true, result: 'done' }
          : { ok: true };
      },
    };
    const queue = new Queue('wait', { connection: connection as unknown as Connection });
    return { queue, calls };
  }

  // sdk/CLAUDE.md rule 4 and protocol spec: waitForJob clamps to [0, 600000] with a
  // finite guard. NaN used to fail serialization; it now means the default hold.
  test('a NaN ttl falls back to the 30000 ms default; a non-numeric value throws', async () => {
    const { queue, calls } = recordingQueue();
    await queue.waitForJob('job-1', Number.NaN);
    expect(calls.map(({ command }) => command.timeout)).toEqual([30_000]);
    expect(calls.map(({ timeoutMs }) => timeoutMs)).toEqual([35_000]);
    await expect(queue.waitForJob('job-1', 'soon' as unknown as number)).rejects.toThrow(
      'Queue: waitForJob() ttlMs must be a number of milliseconds (got "soon")'
    );
    expect(calls).toHaveLength(1);
  });

  test('the documented clamp to [0, 600000] is kept and null is a zero hold, as in 0.2.2', async () => {
    const { queue, calls } = recordingQueue();
    await queue.waitForJob('a', 900_000);
    await queue.waitForJob('b', -5);
    await queue.waitForJob('c', Number.POSITIVE_INFINITY);
    await queue.waitForJob('d', null as unknown as number);
    expect(calls.map(({ command }) => command.timeout)).toEqual([600_000, 0, 600_000, 0]);
    expect(calls.map(({ timeoutMs }) => timeoutMs)).toEqual([605_000, 5000, 605_000, 5000]);
  });
});
