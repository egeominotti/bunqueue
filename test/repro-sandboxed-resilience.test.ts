/**
 * Repro: SandboxedWorker resilience (no threads, no broker).
 *
 * 1. The pull loop had no error handling: one rejected pull (a TCP error, a broker
 *    refusal) or one failed thread respawn rejected the loop's promise, and the
 *    pool never pulled again. A refused TCP PULL was also read as an empty queue.
 * 2. A failed start() left `running` true with no pull loop, so a later start()
 *    did nothing; it kept its threads, wrapper and TCP pool reference; and an
 *    `autoStart` restart failure was swallowed, with the watch already cancelled.
 */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxedWorker } from '../src/client/sandboxed';
import { createTcpOps } from '../src/client/sandboxed/queueOps';
import { getSharedPool, releaseSharedPool, type TcpConnectionPool } from '../src/client/tcpPool';
import {
  SandboxedProbe,
  fakeBroker,
  scriptedJob,
  until,
  type ProbeOptions,
} from './sandboxed-timers-support';
import { installFakeTimers, restoreTimers } from './shared-timers-support';

type ReportedError = Error & { context?: string; consecutiveErrors?: number; queue?: string };

let dir = '';
let processor = '';
const probes: SandboxedProbe[] = [];
const workers: SandboxedWorker[] = [];
const pools: TcpConnectionPool[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bunqueue-sandboxed-resilience-'));
  processor = join(dir, 'processor.ts');
  writeFileSync(processor, 'export default async () => null;\n');
});

afterEach(async () => {
  restoreTimers();
  for (const created of probes.splice(0)) await created.stop(true);
  for (const worker of workers.splice(0)) await worker.stop(true);
  for (const pool of pools.splice(0)) pool.close();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function probe(options: ProbeOptions): { created: SandboxedProbe; errors: ReportedError[] } {
  const created = new SandboxedProbe({ processor, ...options });
  const errors: ReportedError[] = [];
  created.on('error', (error) => errors.push(error));
  probes.push(created);
  return { created, errors };
}

const summary = (errors: ReportedError[]) =>
  errors.map((error) => [error.message, error.context, error.consecutiveErrors]);

describe('the pull loop survives errors (defect 1)', () => {
  test('a pull error is reported and retried with the Worker backoff', async () => {
    const timers = installFakeTimers();
    const { calls, manager } = fakeBroker();
    const lost = () => new Error('connection lost');
    calls.script.push(lost(), lost(), lost());
    const { created, errors } = probe({ manager });
    created.runPullLoopIdle();
    for (const [count, backoff] of [
      [1, 100],
      [2, 200],
      [3, 400],
    ]) {
      await until(() => errors.length === count, `pull error ${count}`);
      expect(timers.delays().at(-1)).toBe(backoff);
      timers.advance(backoff);
    }
    await until(() => calls.pulls >= 6, 'pulls after the errors');
    expect(summary(errors)).toEqual([
      ['connection lost', 'pull', 1],
      ['connection lost', 'pull', 2],
      ['connection lost', 'pull', 3],
    ]);
    expect(errors[0].queue).toBe('sandboxed-probe');
  });

  test('an answered pull, even an empty one, resets the backoff', async () => {
    const timers = installFakeTimers();
    const { calls, manager } = fakeBroker();
    calls.script.push(new Error('a'), new Error('b'), () => undefined, new Error('c'));
    const { created, errors } = probe({ manager });
    created.runPullLoopIdle();
    await until(() => errors.length === 1, 'error a');
    timers.advance(100);
    await until(() => errors.length === 2, 'error b');
    timers.advance(200);
    await until(() => errors.length === 3, 'error c');
    expect(timers.delays()).toEqual([100, 200, 100]);
    expect(summary(errors).map(([, , streak]) => streak)).toEqual([1, 2, 1]);
  });

  test('a refused TCP PULL is a pull error, not an empty queue', async () => {
    const reply = { ok: false, error: 'Invalid queue name' };
    const refused = createTcpOps({
      send: () => Promise.resolve(reply),
    } as unknown as TcpConnectionPool);
    await expect(refused.pull('q', 'w', 1000)).rejects.toThrow(
      'PULL refused by the broker: Invalid queue name'
    );
    const empty = createTcpOps({
      send: () => Promise.resolve({ ok: true, job: null }),
    } as unknown as TcpConnectionPool);
    expect(await empty.pull('q', 'w', 1000)).toEqual({ job: null, token: null });
  });

  test('a transient refusal is an empty pull: pollInterval, no backoff, not emitted', async () => {
    // 2.9.10 read it as an empty queue (test/repro-compat-client-pull-cadence.test.ts).
    const timers = installFakeTimers();
    const { manager } = fakeBroker();
    const created = new SandboxedProbe({ processor, manager });
    probes.push(created);
    const emitted = created.recordErrorEmits();
    const limited = { ok: false, error: 'Rate limit exceeded' };
    const pulls = created.tcpPullReplies([limited, limited]);
    created.runPullLoopIdle();
    await until(() => timers.delays().length === 1, 'the first wait');
    timers.advance(10);
    await until(() => timers.delays().length === 2, 'the second wait');
    timers.advance(10);
    await until(() => pulls.sent() >= 3, 'pulls after the refusals');
    expect(timers.delays()).toEqual([10, 10]);
    expect(emitted).toEqual([]);
  });

  test('a transient refusal is not reported, even to an attached listener (as on 2.9.10)', async () => {
    const { manager } = fakeBroker();
    const { created, errors } = probe({ manager });
    const pulls = created.tcpPullReplies([{ ok: false, error: 'Rate limit exceeded' }]);
    created.runPullLoopIdle();
    await until(() => pulls.sent() >= 2, 'a pull after the refusal');
    expect(errors).toEqual([]);
  });

  test('with no listener a permanent refusal is logged once, never emitted (it could end the process)', async () => {
    const created = new SandboxedProbe({ processor, manager: fakeBroker().manager });
    probes.push(created);
    const emitted = created.recordErrorEmits();
    const log = spyOn(console, 'error').mockImplementation(() => {});
    const pulls = created.tcpPullReplies([{ ok: false, error: 'Invalid queue name' }]);
    created.runPullLoopIdle();
    let lines: string[] = [];
    try {
      await until(() => pulls.sent() >= 3, 'pulls after the refusal');
      lines = log.mock.calls.map((call) => String(call[0]));
    } finally {
      log.mockRestore();
    }
    expect(emitted).toEqual([]);
    expect(lines.filter((line) => line.includes('SandboxedWorker "sandboxed-probe"'))).toHaveLength(
      1
    );
  });

  test('stop() ends the loop at once while it backs off', async () => {
    const { calls, manager } = fakeBroker();
    for (let i = 0; i < 20; i++) calls.script.push(new Error('connection lost'));
    const { created, errors } = probe({ manager });
    created.runPullLoopIdle();
    // The third error arms a 400 ms backoff.
    await until(() => errors.length === 3, 'three pull errors');
    const started = performance.now();
    await created.stop();
    expect(performance.now() - started).toBeLessThan(100);
    expect(created.isRunning()).toBe(false);
  });

  test('a failed thread respawn is reported and retried', async () => {
    const { calls, manager } = fakeBroker();
    const { created, errors } = probe({ manager });
    created.addThread(false).terminated = true;
    created.failSpawnAt = new Set([1]);
    created.runPullLoop();
    await until(() => calls.pulls >= 1, 'a pull after the respawn is retried');
    expect(summary(errors)).toEqual([['processor module failed to load', 'spawn', 1]]);
    expect(created.spawns).toBe(2);
  });

  test('a job pulled for a thread that then fails to respawn is failed, not leaked', async () => {
    const { calls, manager } = fakeBroker();
    const { created, errors } = probe({ manager });
    const thread = created.addThread(false);
    created.failSpawnAt = new Set([1]);
    calls.script.push(() => {
      // The idle thread is recycled while the pull is in flight.
      thread.terminated = true;
      return scriptedJob('pulled-job');
    });
    created.runPullLoop();
    await until(() => calls.failures.length === 1, 'the pulled job to be failed');
    expect(calls.failures).toEqual(['Dispatch failed: processor module failed to load']);
    expect(summary(errors)).toEqual([['processor module failed to load', 'spawn', 1]]);
  });
});

describe('a failed start() leaves the worker stopped (defect 2)', () => {
  test('a start() that cannot load the processor rejects, then a later start() works', async () => {
    const missing = join(dir, 'written-later.ts');
    const { manager } = fakeBroker();
    const { created } = probe({ manager, processor: missing });
    await expect(created.start()).rejects.toThrow('Processor file not visible');
    expect(created.isRunning()).toBe(false);

    writeFileSync(missing, 'export default async () => null;\n');
    await created.start();
    expect(created.isRunning()).toBe(true);
    expect(created.getStats().total).toBe(1);
  });

  test('a start() whose threads fail to load terminates the ones that started', async () => {
    const { manager } = fakeBroker();
    const { created, errors } = probe({ manager, concurrency: 3 });
    created.failSpawnAt = new Set([2]);
    await expect(created.start()).rejects.toThrow('processor module failed to load');
    expect(created.isRunning()).toBe(false);
    expect(created.getStats().total).toBe(0);
    expect(created.terminations).toBe(2);
    expect(created.wrapperFile).toBeNull();
    expect(created.heartbeatArmed).toBe(false);
    // The caller's rejection is the report: no 'error' event as well.
    expect(errors).toEqual([]);
  });

  test('a failed TCP start() releases its shared pool reference', async () => {
    const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const connection = { host: '127.0.0.1', port: listener.port, poolSize: 3 };
    listener.stop(true);
    const other = getSharedPool(connection);
    pools.push(other);
    const worker = new SandboxedWorker('sandboxed-failed-start', { processor, connection });
    workers.push(worker);
    await expect(worker.start()).rejects.toThrow();
    expect(worker.isRunning()).toBe(false);
    releaseSharedPool(other);
    expect(other.isClosed()).toBe(true);
  });

  test('autoStart: a failed restart is reported, backed off and retried', async () => {
    const timers = installFakeTimers();
    const { manager } = fakeBroker();
    const { created, errors } = probe({ manager, autoStart: true, autoStartPollMs: 1_000 });
    const gate = created.gateCounts();
    created.failSpawnAt = new Set([1, 2]);
    await created.stopAndWatchQueue();
    expect(timers.delays()).toEqual([1_000]);

    for (const [attempt, backoff] of [
      [1, 2_000],
      [2, 4_000],
    ]) {
      timers.advance(timers.delays().at(-1) as number);
      await until(() => gate.calls === attempt, `Count ${attempt}`);
      gate.answer(1);
      await until(() => errors.length === attempt, `restart failure ${attempt}`);
      expect(created.isRunning()).toBe(false);
      expect(created.getStats().total).toBe(0);
      expect(timers.delays().at(-1)).toBe(backoff);
    }
    timers.advance(1_999);
    expect(gate.calls).toBe(2);
    timers.advance(2_001);
    await until(() => gate.calls === 3, 'Count 3');
    gate.answer(1);
    await until(() => created.isRunning() && created.getStats().total === 1, 'the restart');
    expect(summary(errors)).toEqual([
      ['processor module failed to load', 'restart', 1],
      ['processor module failed to load', 'restart', 2],
    ]);
  });

  test('a user start() that fails while idle-watching rejects and keeps watching', async () => {
    const { manager } = fakeBroker();
    const { created, errors } = probe({ manager, autoStart: true, autoStartPollMs: 60_000 });
    await created.stopAndWatchQueue();
    created.failSpawnAt = new Set([1]);
    await expect(created.start()).rejects.toThrow('processor module failed to load');
    expect(created.isRunning()).toBe(false);
    expect(created.watchArmed).toBe(true);
    expect(errors).toEqual([]);
  });
});
