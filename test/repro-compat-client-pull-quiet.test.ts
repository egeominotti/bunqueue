/**
 * Repro (2.9.10 compatibility, pre-commit review):
 *
 * 1. On 2.9.10 a refused pull looked like an empty queue, so a Worker emitted no `error`
 *    for a rate limit, a broker lock timeout or a redacted internal error. The candidate
 *    reported those transient refusals to an attached `error` listener, so an app that
 *    alerts on every `error` would start firing on rate limits. They stay silent now
 *    (re-polled on the empty-pull cadence); only a permanent refusal reaches the
 *    listener. The same holds for `getNextJob()` and the SandboxedWorker pull loop.
 * 2. An `error` listener that throws while a pull failure is reported must not turn
 *    into an unhandled rejection (one per failed pull) or end the pull loop: the
 *    listener's own failure is logged, never rethrown.
 * 3. `autoBatch.maxDelayMs: Infinity` or a non-number flushed at once on 2.9.10 (its
 *    timer ran after ~1 ms); it is 0 now instead of a throw. A non-numeric `maxSize`
 *    never flushed by size (`pending >= NaN`), so it is no size limit.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from '../src/client';
import { resolveAutoBatchConfig } from '../src/client/queue/addBatcher';
import { PullRefusedError } from '../src/client/worker/workerPull';
import { SandboxedProbe, fakeBroker, until } from './sandboxed-timers-support';
import { cleanup, closedPort } from './tcp-client-support';

const ROOT = join(import.meta.dir, '..');
const TRANSIENT = ['Rate limit exceeded', 'Internal server error', 'Lock acquisition timed out'];
const workers: Worker[] = [];
const probes: SandboxedProbe[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close(true);
  for (const probe of probes.splice(0)) await probe.stop(true);
  cleanup();
});

/** A TCP Worker whose PULL/PULLB replies are `refusal`; every other command succeeds. */
function refusedWorker(refusal: string): { worker: Worker; pulls: () => number } {
  const worker = new Worker('quiet-refusal', async () => 1, {
    embedded: false,
    autorun: false,
    heartbeatInterval: 0,
    skipStalledCheck: true,
    connection: { host: '127.0.0.1', port: closedPort() },
  });
  workers.push(worker);
  let pulls = 0;
  const pool = worker as unknown as { tcp: { send: (command: { cmd: string }) => unknown } };
  pool.tcp.send = (command) => {
    if (command.cmd !== 'PULL' && command.cmd !== 'PULLB') return Promise.resolve({ ok: true });
    pulls++;
    return Promise.resolve({ ok: false, error: refusal });
  };
  return { worker, pulls: () => pulls };
}

describe('transient pull refusals stay silent, as on 2.9.10', () => {
  test.each(TRANSIENT)('a Worker with an error listener hears nothing for %p', async (reason) => {
    const { worker, pulls } = refusedWorker(reason);
    const errors: Error[] = [];
    worker.on('error', (error) => errors.push(error));
    worker.run();
    await Bun.sleep(450);
    expect(errors).toEqual([]);
    // Re-polled on the 50 ms empty-pull cadence, as on 2.9.10
    // (test/repro-compat-client-pull-cadence.test.ts).
    expect(pulls()).toBeGreaterThanOrEqual(7);
  });

  test('a permanent refusal still reaches the listener', async () => {
    const { worker } = refusedWorker('Not authenticated');
    const errors: Array<Error & { context?: string }> = [];
    worker.on('error', (error) => errors.push(error));
    worker.run();
    await Bun.sleep(150);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].context).toBe('pull');
  });

  test('getNextJob() reports no transient refusal to the listener', async () => {
    const { worker } = refusedWorker('Rate limit exceeded');
    const errors: Error[] = [];
    worker.on('error', (error) => errors.push(error));
    expect(await worker.getNextJob()).toBeUndefined();
    expect(errors).toEqual([]);
  });

  test('a SandboxedWorker with an error listener hears nothing for a transient refusal', async () => {
    const { calls, manager } = fakeBroker();
    for (const reason of TRANSIENT) {
      calls.script.push(new PullRefusedError('PULL', { ok: false, error: reason }));
    }
    const probe = new SandboxedProbe({ manager });
    probes.push(probe);
    const errors: Error[] = [];
    probe.on('error', (error) => errors.push(error));
    probe.addThread(false);
    probe.runPullLoop();
    await until(() => calls.pulls >= 4, 'a pull after the refusals', 3_000);
    expect(errors).toEqual([]);
  });
});

describe('an error listener that throws', () => {
  test('getNextJob() still resolves undefined', async () => {
    const { worker } = refusedWorker('Not authenticated');
    worker.on('error', () => {
      throw new Error('listener failed');
    });
    const log = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await worker.getNextJob()).toBeUndefined();
      const lines = log.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.includes('listener failed'))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  test('the pull loop raises no unhandled rejection and keeps backing off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunqueue-throwing-listener-'));
    try {
      const probe = join(dir, 'probe.ts');
      writeFileSync(
        probe,
        `let unhandled = 0;
process.on('unhandledRejection', () => void unhandled++);
process.on('uncaughtException', () => void unhandled++);
const { Worker } = await import(${JSON.stringify(join(ROOT, 'src/client'))});
const worker = new Worker('throwing-listener', async () => 1, {
  embedded: false, autorun: false, heartbeatInterval: 0, skipStalledCheck: true,
  connection: { host: '127.0.0.1', port: 1 },
});
let pulls = 0;
worker.tcp.send = (command) => {
  if (command.cmd !== 'PULL' && command.cmd !== 'PULLB') return Promise.resolve({ ok: true });
  pulls++;
  return Promise.resolve({ ok: false, error: 'Not authenticated' });
};
worker.on('error', () => { throw new Error('listener failed'); });
worker.run();
await Bun.sleep(450);
console.log(JSON.stringify({ pulls, unhandled }));
await worker.close(true);
process.exit(0);
`
      );
      const child = Bun.spawn([process.execPath, probe], {
        cwd: ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode, stderr).toBe(0);
      const result = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as Record<string, number>;
      expect(result.unhandled).toBe(0);
      expect(result.pulls).toBeGreaterThanOrEqual(2);
      expect(result.pulls).toBeLessThanOrEqual(4);
      expect(stderr.split('\n').filter((line) => line.includes('listener failed'))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('autoBatch values that flushed at once on 2.9.10', () => {
  test('maxDelayMs Infinity or a non-number is 0', () => {
    for (const maxDelayMs of [Infinity, 'soon', {}, true]) {
      expect(resolveAutoBatchConfig({ maxDelayMs: maxDelayMs as never })?.maxDelayMs).toBe(0);
    }
  });

  test('a non-numeric maxSize is no size limit (Infinity)', () => {
    for (const maxSize of ['many', {}]) {
      expect(resolveAutoBatchConfig({ maxSize: maxSize as never })?.maxSize).toBe(Infinity);
    }
  });
});
