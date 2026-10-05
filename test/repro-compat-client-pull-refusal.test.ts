/**
 * Repro (2.9.10 compatibility): a PULL the broker refuses for good (a wrong token, an
 * invalid queue name, a rejected option) must never end the process.
 *
 * On 2.9.10 such a refusal looked like an empty queue: the Worker idled and the process
 * (which may host other Workers or an HTTP server) kept running. The 2.9.11 candidate
 * emitted it as `error` even without a listener, and EventEmitter throws an unheard
 * `error`, which surfaced as an unhandled rejection and ended the process.
 *
 * Now a refusal stays observable without being fatal: with an `error` listener it is
 * emitted (context 'pull'); without one it is logged once (at most once a minute) with
 * the queue and the reason. Either way the pull backs off from 100 ms to 30 s and
 * resumes as soon as the cause is fixed. getNextJob() resolves undefined, as on 2.9.10,
 * and reports the refusal the same way. The SandboxedWorker pull loop follows suit.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from '../src/client';
import { PullRefusedError } from '../src/client/worker/workerPull';
import { SandboxedProbe, fakeBroker, until } from './sandboxed-timers-support';
import { cleanup, closedPort } from './tcp-client-support';

const ROOT = join(import.meta.dir, '..');
const src = (path: string) => JSON.stringify(join(ROOT, path));

afterEach(cleanup);

interface ProbeRun {
  exitCode: number;
  stderr: string;
  result: Record<string, unknown>;
}

/**
 * Run `body` as a script in a child process. The prelude counts unhandled rejections
 * (Bun prints each and keeps running, Node.js ends the process) as `unhandled`.
 */
async function runProbe(body: string): Promise<ProbeRun> {
  const dir = mkdtempSync(join(tmpdir(), 'bunqueue-compat-refusal-'));
  try {
    const probe = join(dir, 'probe.ts');
    const prelude = `let unhandled = 0;
process.on('unhandledRejection', () => void unhandled++);
process.on('uncaughtException', () => void unhandled++);
`;
    writeFileSync(probe, prelude + body);
    const child = Bun.spawn([process.execPath, probe], {
      cwd: ROOT,
      env: { ...process.env, LOG_LEVEL: 'error', BUNQUEUE_DATA_PATH: join(dir, 'q.db') },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const last = stdout.trim().split('\n').pop() ?? '';
    return { exitCode, stderr, result: last.startsWith('{') ? JSON.parse(last) : {} };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('a permanent pull refusal without an error listener', () => {
  test('a Worker survives, logs once, backs off and recovers once the cause is fixed', async () => {
    const run = await runProbe(`
import { QueueManager } from ${src('src/application/queueManager')};
import { createTcpServer } from ${src('src/infrastructure/server/tcp')};
import { Queue, Worker } from ${src('src/client')};

const manager = new QueueManager();
const server = createTcpServer(manager, { hostname: '127.0.0.1', port: 0 });
const connection = { host: '127.0.0.1', port: server.server.port, poolSize: 1 };
const worker = new Worker('refused', async () => 'done', {
  embedded: false, connection, autorun: false, heartbeatInterval: 0, skipStalledCheck: true,
});
const pool = worker as unknown as { tcp: { send: (...args: unknown[]) => Promise<unknown> } };
const send = pool.tcp.send.bind(pool.tcp);
let refusing = true;
let pulls = 0;
pool.tcp.send = (command: { cmd?: string }, ...rest: unknown[]) => {
  if (command.cmd === 'PULL' || command.cmd === 'PULLB') {
    pulls++;
    if (refusing) return Promise.resolve({ ok: false, error: 'Not authenticated' });
  }
  return send(command, ...rest);
};
let completed = 0;
worker.on('completed', () => completed++);
worker.run();
await Bun.sleep(450);
const refusedPulls = pulls;
refusing = false;
const queue = new Queue('refused', { embedded: false, connection });
await queue.add('job', {});
const deadline = Date.now() + 5000;
while (completed === 0 && Date.now() < deadline) await Bun.sleep(20);
console.log(JSON.stringify({ refusedPulls, completed, unhandled }));
await worker.close(true);
await queue.close();
server.stop();
manager.shutdown();
process.exit(0);
`);
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.result).toMatchObject({ completed: 1, unhandled: 0 });
    // Backoff 100 ms then 200 ms: pulls at about 0, 100 and 300 ms (a 50 ms drainDelay
    // re-poll would have made about 9).
    expect(run.result.refusedPulls).toBeGreaterThanOrEqual(2);
    expect(run.result.refusedPulls).toBeLessThanOrEqual(4);
    const lines = run.stderr.split('\n').filter((line) => line.includes('Not authenticated'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Worker "refused"');
  }, 20_000);

  test('a SandboxedWorker survives, logs once and keeps pulling', async () => {
    const run = await runProbe(`
import { SandboxedProbe, fakeBroker } from ${src('test/sandboxed-timers-support')};
import { PullRefusedError } from ${src('src/client/worker/workerPull')};

const { calls, manager } = fakeBroker();
for (let i = 0; i < 3; i++) {
  calls.script.push(new PullRefusedError('PULL', { ok: false, error: 'Not authenticated' }));
}
const probe = new SandboxedProbe({ manager });
probe.addThread(false);
probe.runPullLoop();
await Bun.sleep(900);
console.log(JSON.stringify({ pullsAfterRefusals: calls.pulls > 4, unhandled }));
await probe.stop(true);
process.exit(0);
`);
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.result).toEqual({ pullsAfterRefusals: true, unhandled: 0 });
    const lines = run.stderr.split('\n').filter((line) => line.includes('Not authenticated'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('sandboxed-probe');
  }, 20_000);
});

describe('a permanent pull refusal with an error listener', () => {
  test('a SandboxedWorker emits it (context pull) and keeps pulling', async () => {
    const { calls, manager } = fakeBroker();
    calls.script.push(new PullRefusedError('PULL', { ok: false, error: 'Invalid queue name' }));
    const probe = new SandboxedProbe({ manager });
    const errors: Array<Error & Record<string, unknown>> = [];
    probe.on('error', (error) => errors.push(error as Error & Record<string, unknown>));
    try {
      probe.addThread(false);
      probe.runPullLoop();
      await until(() => errors.length === 1 && calls.pulls >= 2, 'the report and a later pull');
      expect(errors[0]).toMatchObject({
        name: 'PullRefusedError',
        reason: 'Invalid queue name',
        transient: false,
        context: 'pull',
        consecutiveErrors: 1,
        queue: 'sandboxed-probe',
      });
    } finally {
      await probe.stop(true);
    }
  });
});

describe('getNextJob() and a permanent refusal', () => {
  function refusedWorker(): Worker {
    const worker = new Worker('manual-refused', async () => 1, {
      embedded: false,
      autorun: false,
      connection: { host: '127.0.0.1', port: closedPort() },
    });
    const pool = worker as unknown as { tcp: { send: () => Promise<unknown> } };
    pool.tcp.send = () => Promise.resolve({ ok: false, error: 'Not authenticated' });
    return worker;
  }

  test('without a listener: resolves undefined, as on 2.9.10, and logs once', async () => {
    const log = spyOn(console, 'error').mockImplementation(() => {});
    const worker = refusedWorker();
    try {
      expect(await worker.getNextJob()).toBeUndefined();
      expect(await worker.getNextJob()).toBeUndefined();
      const lines = log.mock.calls.map((call) => String(call[0]));
      expect(lines.filter((line) => line.includes('Not authenticated'))).toHaveLength(1);
    } finally {
      log.mockRestore();
      await worker.close(true);
    }
  });

  test('with a listener: resolves undefined and emits error with context pull', async () => {
    const worker = refusedWorker();
    const errors: Array<Error & { context?: string }> = [];
    worker.on('error', (error: Error & { context?: string }) => errors.push(error));
    try {
      expect(await worker.getNextJob()).toBeUndefined();
      expect(errors).toHaveLength(1);
      expect(errors[0].context).toBe('pull');
      expect(errors[0].message).toContain('Not authenticated');
    } finally {
      await worker.close(true);
    }
  });
});
