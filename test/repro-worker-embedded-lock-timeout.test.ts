/**
 * Repro: under shard contention longer than `LOCK_TIMEOUT_MS`, an embedded pull rejects
 * with the `LockTimeoutError` itself (`shared/lockError.ts`), not a broker refusal.
 * `isTransientPullError` recognised only the refusal (TCP), so an embedded Worker or
 * SandboxedWorker without an `error` listener emitted it unconditionally, which ends
 * the process. A lock timeout passes with time: it must be retried with the pull
 * backoff and reported only to an attached listener.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from '../src/client';
import { isTransientPullError } from '../src/client/worker/workerPull';
import {
  LockTimeoutError,
  READ_LOCK_TIMEOUT_MESSAGE,
  WRITE_LOCK_TIMEOUT_MESSAGE,
} from '../src/shared/lockError';
import { closeHarness, startHarness, waitUntil, type CoreE2eHarness } from './docs-guide-support';
import { SandboxedProbe, fakeBroker, until } from './sandboxed-timers-support';

const LOCK_TIMEOUTS = [
  new LockTimeoutError(),
  new LockTimeoutError(READ_LOCK_TIMEOUT_MESSAGE),
  new LockTimeoutError(WRITE_LOCK_TIMEOUT_MESSAGE),
];

let harness: CoreE2eHarness | null = null;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await closeHarness(harness);
  harness = null;
});

/** Count `error` emits made while no listener is attached: each one ends the process. */
function countUnhandledErrors(emitter: Worker): { count: number } {
  const unhandled = { count: 0 };
  const emit = emitter.emit.bind(emitter);
  emitter.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (event === 'error' && emitter.listenerCount('error') === 0) {
      unhandled.count++;
      return false;
    }
    return emit(event, ...args);
  }) as Worker['emit'];
  return unhandled;
}

type PullMethod = (...args: unknown[]) => Promise<unknown>;

/** Reject the first `failures` embedded pulls with a lock timeout. */
function failEmbeddedPulls(active: CoreE2eHarness, failures: number): void {
  const manager = active.brokerManager() as unknown as Record<string, PullMethod>;
  let pulls = 0;
  for (const method of ['pullWithLock', 'pullBatchWithLock', 'pull', 'pullBatch']) {
    const original = manager[method];
    manager[method] = (...args) =>
      ++pulls <= failures ? Promise.reject(new LockTimeoutError()) : original.apply(manager, args);
    cleanups.push(() => {
      manager[method] = original;
    });
  }
}

describe('an embedded lock timeout is a transient pull error', () => {
  test.each(LOCK_TIMEOUTS.map((error) => [error.message, error] as const))(
    'a thrown LockTimeoutError (%p) is transient',
    (_message, error) => {
      expect(isTransientPullError(error)).toBe(true);
    }
  );

  test('an embedded Worker without an error listener survives lock timeouts', async () => {
    harness = await startHarness('worker-embedded-lock-timeout', 'embedded');
    const queue = harness.queue('lock-timeout');
    const worker = new Worker(
      queue.name,
      async () => 'done',
      harness.workerOptions({ autorun: false, heartbeatInterval: 0, skipStalledCheck: true })
    );
    harness.addCleanup(() => worker.close(true));
    let completed = 0;
    worker.on('completed', () => completed++);
    const unhandled = countUnhandledErrors(worker);
    failEmbeddedPulls(harness, 2);

    await queue.add('job', {});
    worker.run();
    await waitUntil(() => completed === 1, 'the job to complete after the lock timeouts', 3_000);

    expect(unhandled.count).toBe(0);
  });

  test('an embedded SandboxedWorker without an error listener survives lock timeouts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunqueue-sandboxed-lock-timeout-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const processor = join(dir, 'processor.ts');
    writeFileSync(processor, 'export default async () => null;\n');
    const { calls, manager } = fakeBroker();
    const probe = new SandboxedProbe({ manager, processor });
    cleanups.push(() => probe.stop(true));
    const emitted = probe.recordErrorEmits();
    calls.script.push(...LOCK_TIMEOUTS);

    probe.addThread(false);
    probe.runPullLoop();
    // Three refused pulls back off 100, 200 and 400 ms; the fourth is answered.
    await until(() => calls.pulls >= 4, 'the pull loop to pull again', 3_000);

    expect(emitted).toEqual([]);
  });
});
