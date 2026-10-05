/**
 * Repro: SandboxedWorker lifecycle defects (no threads, no broker).
 *
 * 1. `concurrency` was unvalidated: start() asked for an endless number of threads
 *    under Infinity, and 1 under NaN. Both throw now; a finite value keeps the thread
 *    count 2.9.10 started (rounded up, at least 1).
 * 2. stop() was not idempotent: every call released the shared TCP pool again, so a
 *    second stop() closed the connections of the pool's other users.
 * 3. A user stop() did not win over the idle watch: a stop() during the idle stop's
 *    drain was followed by the watch being armed, and a watch check (or the restart
 *    it began) in flight during stop() still restarted the pool.
 * 4. The idle watch sent a Count every autoStartPollMs even while the previous one
 *    was still in flight, so a slow broker accumulated requests.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxedWorker } from '../src/client/sandboxed';
import { getSharedPool, releaseSharedPool, type TcpConnectionPool } from '../src/client/tcpPool';
import {
  SPAWN_LIMIT,
  SandboxedProbe,
  fakeBroker,
  until,
  type ProbeOptions,
} from './sandboxed-timers-support';

let dir = '';
let processor = '';
const probes: SandboxedProbe[] = [];
const pools: TcpConnectionPool[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bunqueue-sandboxed-lifecycle-'));
  processor = join(dir, 'processor.ts');
  writeFileSync(processor, 'export default async () => null;\n');
});

afterEach(async () => {
  for (const probe of probes.splice(0)) await probe.stop(true);
  for (const pool of pools.splice(0)) pool.close();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function probe(options: ProbeOptions): SandboxedProbe {
  const created = new SandboxedProbe({ processor, ...options });
  probes.push(created);
  return created;
}

function tryProbe(options: ProbeOptions): SandboxedProbe | Error {
  try {
    return probe(options);
  } catch (error) {
    return error as Error;
  }
}

/** A TCP connection nothing listens on: the pool is shared but never connects. */
function idleConnection(): { host: string; port: number; poolSize: number } {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return { host: '127.0.0.1', port, poolSize: 3 };
}

/** The pool's other user, holding its own reference; closed in afterEach. */
function otherUser(connection: ReturnType<typeof idleConnection>): TcpConnectionPool {
  const pool = getSharedPool(connection);
  pools.push(pool);
  return pool;
}

describe('concurrency (issue 1)', () => {
  for (const value of [NaN, Infinity]) {
    test(`concurrency ${value} is rejected instead of starting a different thread count`, async () => {
      const { manager } = fakeBroker();
      const created = tryProbe({ manager, concurrency: value });
      if (created instanceof Error) {
        expect(created).toBeInstanceOf(RangeError);
        expect(created.message).toBe(
          `SandboxedWorker: concurrency must be a finite number of threads (got ${value})`
        );
        return;
      }
      const outcome = await created.start().then(
        () => 'started',
        (error: Error) => error.message
      );
      throw new Error(
        `concurrency ${value} was accepted: start() asked for ${created.spawns} threads (${outcome})`
      );
    });
  }

  // 2.9.10 spawned slot 0, then `for (i = 1; i < concurrency; i++)`: kept, as the
  // thread count it started (test/repro-compat-client-sandboxed-autobatch.test.ts).
  test.each([
    [1, 1],
    [3, 3],
    [2.5, 3],
    [1.5, 2],
    [0, 1],
    [-1, 1],
    [-Infinity, 1],
    ['2', 2],
  ] as const)(`concurrency %p starts %p threads (limit ${SPAWN_LIMIT})`, async (value, threads) => {
    const { manager } = fakeBroker();
    const created = probe({ manager, concurrency: value as number });
    await created.start();
    expect(created.spawns).toBe(threads);
    expect(created.getStats().total).toBe(threads);
  });

  test.each([
    [2 ** 53, RangeError],
    ['two', TypeError],
  ] as const)('concurrency %p throws %p', (value, kind) => {
    const { manager } = fakeBroker();
    expect(() => probe({ manager, concurrency: value as number })).toThrow(kind);
    expect(() => probe({ manager, concurrency: value as number })).toThrow(
      'SandboxedWorker: concurrency must be a finite number of threads'
    );
  });

  test('a string is shown quoted', () => {
    const { manager } = fakeBroker();
    expect(() => probe({ manager, concurrency: 'two' as unknown as number })).toThrow(
      'SandboxedWorker: concurrency must be a finite number of threads (got "two")'
    );
  });

  test('null and undefined select the default of 1', async () => {
    const { manager } = fakeBroker();
    const created = probe({ manager, concurrency: null as unknown as number });
    await created.start();
    expect(created.spawns).toBe(1);
  });
});

describe('stop() is idempotent (issue 2)', () => {
  test('a second stop() does not release the shared pool again', async () => {
    const connection = idleConnection();
    const other = otherUser(connection);
    const worker = new SandboxedWorker('sandboxed-pool-a', { processor, connection });
    await worker.stop();
    await worker.stop();
    expect(other.isClosed()).toBe(false);
    // The other user's reference is now the last one: releasing it closes the pool.
    releaseSharedPool(other);
    expect(other.isClosed()).toBe(true);
  });

  test('concurrent stop() calls release the shared pool once', async () => {
    const connection = idleConnection();
    const other = otherUser(connection);
    const worker = new SandboxedWorker('sandboxed-pool-b', { processor, connection });
    await Promise.all([worker.stop(), worker.stop(true), worker.stop()]);
    expect(other.isClosed()).toBe(false);
    releaseSharedPool(other);
    expect(other.isClosed()).toBe(true);
  });

  test('start() during a stop() waits for the teardown, then starts cleanly', async () => {
    const { manager } = fakeBroker();
    const created = probe({ manager });
    await created.start();
    const thread = created.addThread(true);
    const stopping = created.stop();
    const starting = created.start();
    thread.busy = false;
    await Promise.all([stopping, starting]);
    expect(created.isRunning()).toBe(true);
    expect(created.getStats()).toMatchObject({ total: 1, idle: 1, busy: 0 });
    expect(created.heartbeatArmed).toBe(true);
  });

  test('stop(true) cuts short a graceful stop() that is draining', async () => {
    const { manager } = fakeBroker();
    const created = probe({ manager });
    created.addThread(true);
    let gracefulDone = false;
    const graceful = created.stop().then(() => {
      gracefulDone = true;
    });
    await Bun.sleep(30);
    expect(gracefulDone).toBe(false);
    await created.stop(true);
    await graceful;
    expect(created.getStats().total).toBe(0);
  });

  test('closed is emitted once, by the first stop()', async () => {
    const { manager } = fakeBroker();
    const created = probe({ manager });
    let closed = 0;
    created.on('closed', () => closed++);
    await created.stop();
    await created.stop();
    expect(closed).toBe(1);
  });
});

describe('a user stop() wins over the idle watch (issue 3)', () => {
  test('stop() during the idle stop drain leaves no watch armed', async () => {
    const { calls, manager } = fakeBroker();
    const created = probe({ manager, autoStart: true, idleTimeout: 1, autoStartPollMs: 5 });
    const busy = created.addThread(true);
    created.runPullLoopIdle();
    await until(() => !created.isRunning(), 'the idle stop');
    const userStop = created.stop();
    busy.busy = false;
    await userStop;
    await Bun.sleep(60);
    expect(created.watchArmed).toBe(false);
    expect(calls.counts).toBe(0);
    expect(created.startCalls).toBe(0);
  });

  test('stop() while a watch check is in flight prevents the restart', async () => {
    const { manager } = fakeBroker();
    const created = probe({ manager, autoStart: true, autoStartPollMs: 5 });
    const gate = created.gateCounts();
    await created.stopAndWatchQueue();
    await until(() => gate.calls === 1, 'a Count request');
    await created.stop();
    gate.answer(3);
    await Bun.sleep(30);
    expect(created.startCalls).toBe(0);
    expect(created.isRunning()).toBe(false);
    expect(created.watchArmed).toBe(false);
  });

  test('stop() during the restart leaves nothing running', async () => {
    const { manager } = fakeBroker();
    const created = probe({ manager, autoStart: true, autoStartPollMs: 5 });
    const gate = created.gateCounts();
    await created.stopAndWatchQueue();
    await until(() => gate.calls === 1, 'a Count request');
    let userStop: Promise<void> | null = null;
    // The user stops while the restart is still creating its wrapper and threads.
    created.onStart = () => {
      userStop = created.stop();
    };
    gate.answer(1);
    await until(() => userStop !== null, 'the restart');
    await userStop;
    await Bun.sleep(20);
    expect(created.startCalls).toBe(1);
    expect(created.isRunning()).toBe(false);
    expect(created.getStats().total).toBe(0);
    expect(created.heartbeatArmed).toBe(false);
    expect(created.watchArmed).toBe(false);
  });
});

describe('the idle watch keeps at most one Count in flight (issue 4)', () => {
  test('a slow Count is not overlapped by the next poll', async () => {
    const { manager } = fakeBroker();
    const created = probe({ manager, autoStart: true, autoStartPollMs: 5 });
    const gate = created.gateCounts();
    await created.stopAndWatchQueue();
    await Bun.sleep(60);
    expect(gate.inFlight).toBe(1);
    expect(gate.maxInFlight).toBe(1);
    gate.answer(0);
    await until(() => gate.calls >= 2, 'the next Count after the answer');
    await Bun.sleep(30);
    expect(gate.maxInFlight).toBe(1);
    expect(created.startCalls).toBe(0);
  });

  test('a failed Count frees the slot for the next poll', async () => {
    const { manager } = fakeBroker();
    const created = probe({ manager, autoStart: true, autoStartPollMs: 5 });
    const gate = created.gateCounts();
    await created.stopAndWatchQueue();
    for (let call = 1; call <= 3; call++) {
      await until(() => gate.calls === call, `Count ${call}`);
      gate.fail(new Error('broker unavailable'));
    }
    expect(gate.maxInFlight).toBe(1);
    expect(created.startCalls).toBe(0);
  });
});
