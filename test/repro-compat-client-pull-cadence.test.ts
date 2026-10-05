/**
 * Repro (2.9.10 compatibility, pre-commit review): the re-poll cadence after a
 * transient pull refusal (the broker's rate limit, a lock timeout, a redacted internal
 * error).
 *
 * On 2.9.10 a refused pull looked like an empty queue, so a Worker re-polled on its
 * empty-pull cadence (`pollTimeout > 0 ? 10 : drainDelay`, 50 ms by default) and a
 * native-batch refill on its 10 ms refill timer, with no failure streak. The candidate
 * backed off from 100 ms to 30 s instead, so sustained broker rate limiting or lock
 * contention could delay job pickup by up to 30 s. The empty-pull cadence is restored
 * for transient refusals; the 100 ms to 30 s backoff stays for permanent ones (a bad
 * token, an invalid queue name), which 2.9.10 never reported at all.
 *
 * The SandboxedWorker treats a transient refusal as an empty pull too (spare threads
 * recycled, `idleTimeout` counted, as on 2.9.10), then waits `pollInterval` before the
 * next pull: 2.9.10 re-pulled at once, a request flood against a rate-limiting broker.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Worker } from '../src/client';
import { PullRefusedError } from '../src/client/worker/workerPull';
import { closeHarness, startHarness, waitUntil, type CoreE2eHarness } from './docs-guide-support';
import { SandboxedProbe, fakeBroker, until } from './sandboxed-timers-support';
import { cleanup, closedPort } from './tcp-client-support';

const workers: Worker[] = [];
const probes: SandboxedProbe[] = [];
let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close(true);
  for (const probe of probes.splice(0)) await probe.stop(true);
  await closeHarness(harness);
  harness = null;
  cleanup();
});

type Options = ConstructorParameters<typeof Worker>[2];
type PullError = Error & { context?: string; consecutiveErrors?: number };

/** A TCP Worker whose nth PULL/PULLB is answered by `reply(n)`; other commands succeed. */
function stubbedWorker(reply: (n: number) => string, options: Options = {}) {
  const worker = new Worker('cadence', async () => 1, {
    embedded: false,
    autorun: false,
    heartbeatInterval: 0,
    skipStalledCheck: true,
    connection: { host: '127.0.0.1', port: closedPort() },
    ...options,
  });
  workers.push(worker);
  let pulls = 0;
  const pool = worker as unknown as { tcp: { send: (command: { cmd: string }) => unknown } };
  pool.tcp.send = (command) => {
    if (command.cmd !== 'PULL' && command.cmd !== 'PULLB') return Promise.resolve({ ok: true });
    pulls++;
    return Promise.resolve({ ok: false, error: reply(pulls) });
  };
  const errors: PullError[] = [];
  worker.on('error', (error: PullError) => errors.push(error));
  return { worker, errors, pulls: () => pulls };
}

describe('Worker: a transient refusal re-polls on the empty-pull cadence', () => {
  test('drainDelay (50 ms by default) without a long-poll, as on 2.9.10', async () => {
    const { worker, errors, pulls } = stubbedWorker(() => 'Rate limit exceeded');
    worker.run();
    await Bun.sleep(450);
    // Pulls at about 0, 50, ..., 400 ms; a 100 ms..30 s backoff makes 3.
    expect(pulls()).toBeGreaterThanOrEqual(7);
    expect(errors).toEqual([]);
  });

  test('10 ms with a long-poll (pollTimeout > 0), as on 2.9.10', async () => {
    const { worker, pulls } = stubbedWorker(() => 'Lock acquisition timed out', {
      pollTimeout: 1_000,
    });
    worker.run();
    await Bun.sleep(300);
    expect(pulls()).toBeGreaterThanOrEqual(12);
  });

  test('transient refusals do not escalate the backoff of a later permanent one', async () => {
    const { worker, errors } = stubbedWorker((n) =>
      n <= 4 ? 'Internal server error' : 'Not authenticated'
    );
    worker.run();
    await waitUntil(() => errors.length >= 1, 'the permanent refusal', 3_000);
    expect(errors[0].consecutiveErrors).toBe(1);
  });

  test('a permanent refusal still backs off from 100 ms', async () => {
    const { worker, pulls } = stubbedWorker(() => 'Not authenticated');
    worker.run();
    await Bun.sleep(450);
    expect(pulls()).toBeLessThanOrEqual(4);
  });

  test('a native batch refill retries a transient refusal on its 10 ms refill timer', async () => {
    harness = await startHarness('pull-cadence', 'tcp');
    const queue = harness.queue('refill');
    const worker = new Worker(
      queue.name,
      async () => 'done',
      harness.workerOptions({
        autorun: false,
        heartbeatInterval: 0,
        skipStalledCheck: true,
        batch: { size: 4, minSize: 2 },
      })
    );
    harness.addCleanup(() => worker.close(true));
    const pool = worker as unknown as { tcp: { send: (...args: unknown[]) => unknown } };
    const send = pool.tcp.send.bind(pool.tcp);
    let pulls = 0;
    pool.tcp.send = (command: { cmd?: string }, ...rest: unknown[]) => {
      if (command.cmd === 'PULL' || command.cmd === 'PULLB') {
        pulls++;
        if (pulls > 1) return Promise.resolve({ ok: false, error: 'Rate limit exceeded' });
      }
      return send(command, ...rest);
    };
    await queue.add('job', {});
    worker.run();
    await waitUntil(() => pulls >= 2, 'the first refill', 2_000);
    const before = pulls;
    await Bun.sleep(300);
    // About one refill every 10 ms; a 100 ms..30 s backoff makes 2 or 3.
    expect(pulls - before).toBeGreaterThanOrEqual(10);
  });
});

describe('SandboxedWorker: a transient refusal is an empty pull', () => {
  const refusals = (count: number) =>
    Array.from(
      { length: count },
      () => new PullRefusedError('PULL', { ok: false, error: 'Rate limit exceeded' })
    );

  test('the next pull follows after pollInterval, not after a growing backoff', async () => {
    const { calls, manager } = fakeBroker();
    calls.script.push(...refusals(100));
    const probe = new SandboxedProbe({ manager, pollInterval: 10 });
    probes.push(probe);
    const errors: Error[] = [];
    probe.on('error', (error) => errors.push(error));
    probe.addThread(false);
    probe.runPullLoop();
    await Bun.sleep(300);
    // About one pull every 15 ms (5 ms broker + 10 ms); a backoff makes 3.
    expect(calls.pulls).toBeGreaterThanOrEqual(10);
    expect(errors).toEqual([]);
  });

  test('it counts toward idleTimeout, as an empty pull did on 2.9.10', async () => {
    const { calls, manager } = fakeBroker();
    calls.script.push(...refusals(1));
    const probe = new SandboxedProbe({ manager, idleTimeout: 1 });
    probes.push(probe);
    probe.runPullLoopIdle();
    // The idle stop follows the refused pull itself, not a pull after a 100 ms backoff.
    await until(() => !probe.isRunning(), 'the idle stop', 60);
    expect(calls.pulls).toBe(1);
  });
});
