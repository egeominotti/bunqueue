/**
 * Repro: `pullTcp` read every refused PULL/PULLB reply (`ok: false`) as an empty queue,
 * and `getNextJob()` did the same. A Worker the broker refuses for good (an invalid
 * queue name, a rejected option, a missing auth token) therefore sat silently idle:
 * no `error` event, a false `drained` event, and a re-poll every `drainDelay` forever.
 *
 * A refusal is now a pull error. A permanent one is reported like any other pull
 * error (an `error` event with `context: 'pull'` when there is a listener, otherwise a
 * console line at most once a minute; then the 100 ms..30 s backoff). A transient one
 * (the broker's rate limit, a redacted storage error such as a PostgreSQL shutdown) is
 * read as an empty pull, as on 2.9.10: re-polled on the empty-pull cadence, not reported.
 * Neither ever crashes a Worker that has no listener (2.9.10 kept running; see
 * test/repro-compat-client-pull-refusal.test.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from '../src/client';
import { closeHarness, startHarness, waitUntil, type CoreE2eHarness } from './docs-guide-support';

/** Rejected by the broker's queue-name validation, accepted by the Worker. */
const INVALID_QUEUE = 'bad queue!';
const ROOT = join(import.meta.dir, '..');

let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  await closeHarness(harness);
  harness = null;
});

type Send = (
  command: Record<string, unknown>,
  options?: { timeout?: number }
) => Promise<Record<string, unknown>>;

interface PullCount {
  count: number;
}

/** Count the PULL/PULLB commands of `worker`; `refuse(n)` may refuse the nth one. */
function interceptPulls(worker: Worker, refuse?: (n: number) => string | null): PullCount {
  const pool = (worker as unknown as { tcp: { send: Send } }).tcp;
  const send = pool.send.bind(pool);
  const pulls: PullCount = { count: 0 };
  pool.send = async (command, options) => {
    if (command.cmd === 'PULL' || command.cmd === 'PULLB') {
      pulls.count++;
      const message = refuse?.(pulls.count);
      if (message) return { ok: false, error: message };
    }
    return send(command, options);
  };
  return pulls;
}

type PullError = Error & {
  context?: string;
  consecutiveErrors?: number;
  transient?: boolean;
  queue?: string;
};

function tcpWorker(active: CoreE2eHarness, queue: string, processor = async () => 'done') {
  const worker = new Worker(
    queue,
    processor,
    active.workerOptions({ autorun: false, heartbeatInterval: 0, skipStalledCheck: true })
  );
  active.addCleanup(() => worker.close(true));
  return worker;
}

describe('Worker pull refusals [tcp]', () => {
  test('a permanent refusal is an error with backoff, not an empty queue', async () => {
    harness = await startHarness('worker-pull-refusal', 'tcp');
    const worker = tcpWorker(harness, INVALID_QUEUE);
    const errors: PullError[] = [];
    let drained = 0;
    worker.on('error', (error: PullError) => {
      if (error.context === 'pull') errors.push(error);
    });
    worker.on('drained', () => drained++);
    const pulls = interceptPulls(worker);

    worker.run();
    await Bun.sleep(450);
    const seen = { pulls: pulls.count, drained, errors: errors.length };

    // Backoff 100 ms then 200 ms: pulls at about 0, 100 and 300 ms (a drainDelay of
    // 50 ms used to re-poll about 9 times).
    expect(seen).toEqual({ pulls: 3, drained: 0, errors: 3 });
    expect(errors[0].message).toContain('Queue name contains invalid characters');
    expect(errors[0].name).toBe('PullRefusedError');
    expect(errors[0].transient).toBe(false);
    expect(errors[0].queue).toBe(INVALID_QUEUE);
    expect(errors.map((error) => error.consecutiveErrors)).toEqual([1, 2, 3]);
  });

  test('a transient refusal is re-polled and never crashes a Worker without an error listener', async () => {
    harness = await startHarness('worker-pull-refusal', 'tcp');
    const queue = harness.queue('transient');
    const worker = tcpWorker(harness, queue.name);
    let drained = 0;
    const seen: { drainedBeforeActive: number | null } = { drainedBeforeActive: null };
    let completed = 0;
    worker.on('drained', () => drained++);
    worker.on('active', () => (seen.drainedBeforeActive ??= drained));
    worker.on('completed', () => completed++);
    const pulls = interceptPulls(worker, (n) => (n <= 2 ? 'Rate limit exceeded' : null));

    await queue.add('job', {});
    worker.run();
    await waitUntil(() => completed === 1, 'the job to complete after the refusals', 3_000);

    // Two refused pulls, then the one that leased the job (a later empty poll may follow).
    expect(pulls.count).toBeGreaterThanOrEqual(3);
    // A refusal is not an empty queue: no `drained` while the job was waiting.
    expect(seen.drainedBeforeActive).toBe(0);
  });

  test('a transient refusal is not reported, even to an attached error listener', async () => {
    harness = await startHarness('worker-pull-refusal', 'tcp');
    const queue = harness.queue('transient-listened');
    const worker = tcpWorker(harness, queue.name);
    const errors: PullError[] = [];
    let completed = 0;
    worker.on('error', (error: PullError) => {
      if (error.context === 'pull') errors.push(error);
    });
    worker.on('completed', () => completed++);
    interceptPulls(worker, (n) => (n === 1 ? 'Rate limit exceeded' : null));

    await queue.add('job', {});
    worker.run();
    await waitUntil(() => completed === 1, 'the job to complete after the refusal', 3_000);

    // 2.9.10 read a refusal as an empty queue: an app alerting on every `error` never
    // heard of a rate limit (test/repro-compat-client-pull-quiet.test.ts).
    expect(errors).toHaveLength(0);
  });

  test('a successful empty pull resets the backoff streak', async () => {
    harness = await startHarness('worker-pull-refusal', 'tcp');
    const queue = harness.queue('streak');
    const worker = tcpWorker(harness, queue.name);
    const errors: PullError[] = [];
    worker.on('error', (error: PullError) => {
      if (error.context === 'pull') errors.push(error);
    });
    // Refuse the 1st and the 3rd pull; the 2nd succeeds with an empty queue.
    interceptPulls(worker, (n) => (n === 1 || n === 3 ? 'lockTtl must be at least 1' : null));

    worker.run();
    await waitUntil(() => errors.length === 2, 'two refusals', 3_000);

    expect(errors.map((error) => error.consecutiveErrors)).toEqual([1, 1]);
  });

  test('a refusal while a native batch waits for minSize backs off too', async () => {
    harness = await startHarness('worker-pull-refusal', 'tcp');
    const queue = harness.queue('batch-refill');
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
    const errors: PullError[] = [];
    worker.on('error', (error: PullError) => {
      if (error.context === 'pull') errors.push(error);
    });
    // The first pull leases the only job; every refill while waiting for a second is refused.
    const pulls = interceptPulls(worker, (n) => (n === 1 ? null : 'lockTtl must be at least 1'));

    await queue.add('job', {});
    worker.run();
    await waitUntil(() => pulls.count >= 2, 'the first refill', 2_000);
    await Bun.sleep(300);

    // Backoff 100 ms then 200 ms: about 3 refused refills (the 10 ms refill timer
    // used to retry about 30 times).
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.length).toBeLessThanOrEqual(4);
    expect(errors.map((error) => error.consecutiveErrors)).toEqual(
      errors.map((_error, index) => index + 1)
    );
  });

  test('getNextJob returns nothing on a refusal and reports a permanent one', async () => {
    harness = await startHarness('worker-pull-refusal', 'tcp');
    const refused = tcpWorker(harness, INVALID_QUEUE);
    const errors: PullError[] = [];
    refused.on('error', (error: PullError) => errors.push(error));
    expect(await refused.getNextJob()).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Queue name contains invalid characters');
    expect(errors[0].context).toBe('pull');

    const queue = harness.queue('manual-transient');
    await queue.add('job', {});
    const limited = tcpWorker(harness, queue.name);
    interceptPulls(limited, (n) => (n === 1 ? 'Rate limit exceeded' : null));
    expect(await limited.getNextJob()).toBeUndefined();
    expect(String((await limited.getNextJob())?.id)).not.toBe('undefined');
  });
});

describe('Worker pull refusals without an error listener', () => {
  test('a permanent refusal keeps the pull loop alive with backoff', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunqueue-pull-refusal-'));
    try {
      const probe = join(dir, 'probe.ts');
      const src = (path: string) => JSON.stringify(join(ROOT, 'src', path));
      writeFileSync(
        probe,
        `import { QueueManager } from ${src('application/queueManager')};
import { createTcpServer } from ${src('infrastructure/server/tcp')};
import { Worker } from ${src('client')};

let unhandled = 0;
process.on('unhandledRejection', () => void unhandled++);
const manager = new QueueManager();
const server = createTcpServer(manager, { hostname: '127.0.0.1', port: 0 });
const worker = new Worker(${JSON.stringify(INVALID_QUEUE)}, async () => 1, {
  embedded: false,
  connection: { host: '127.0.0.1', port: server.server.port, poolSize: 1 },
  autorun: false,
  heartbeatInterval: 0,
  skipStalledCheck: true,
});
const pool = worker as unknown as { tcp: { send: (...args: unknown[]) => Promise<unknown> } };
const send = pool.tcp.send.bind(pool.tcp);
let pulls = 0;
pool.tcp.send = (command: { cmd?: string }, ...rest: unknown[]) => {
  if (command.cmd === 'PULL' || command.cmd === 'PULLB') pulls++;
  return send(command, ...rest);
};
worker.run();
await Bun.sleep(450);
console.log(JSON.stringify({ pulls, unhandled }));
await worker.close(true);
server.stop();
manager.shutdown();
process.exit(0);
`
      );
      const child = Bun.spawn([process.execPath, probe], {
        cwd: ROOT,
        env: { ...process.env, LOG_LEVEL: 'error' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode, stderr).toBe(0);
      const result = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as {
        pulls: number;
        unhandled: number;
      };
      // No unheard `error` is emitted (it would surface as an unhandled rejection); the
      // refusal is logged once instead, and the loop keeps retrying with backoff.
      expect(result).toEqual({ pulls: 3, unhandled: 0 });
      const logged = stderr.split('\n').filter((line) => line.includes('invalid characters'));
      expect(logged).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
