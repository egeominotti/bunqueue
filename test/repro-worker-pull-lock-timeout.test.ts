/**
 * Repro: a broker under shard contention longer than `LOCK_TIMEOUT_MS` answers a PULL
 * or PULLB with `{ ok: false, error: 'Write lock acquisition timed out' }` (or the read
 * or plain lock variant). `sanitizeServerError` does not redact it, so the Worker
 * classified it as a permanent refusal and emitted `error` even without a listener,
 * which ends the process. Before refusals were classified, the same reply was a
 * harmless empty poll. A lock timeout passes with time: it must be retried with the
 * pull backoff and reported only to an attached `error` listener.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Worker } from '../src/client';
import { PullRefusedError, isTransientRefusal } from '../src/client/worker/workerPull';
import { closeHarness, startHarness, waitUntil, type CoreE2eHarness } from './docs-guide-support';

const LOCK_TIMEOUTS = [
  'Lock acquisition timed out',
  'Read lock acquisition timed out',
  'Write lock acquisition timed out',
];

let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  await closeHarness(harness);
  harness = null;
});

type Send = (
  command: Record<string, unknown>,
  options?: { timeout?: number }
) => Promise<Record<string, unknown>>;

/** Refuse the first `refusals` PULL/PULLB commands of `worker` with `message`. */
function refusePulls(worker: Worker, refusals: number, message: string): void {
  const pool = (worker as unknown as { tcp: { send: Send } }).tcp;
  const send = pool.send.bind(pool);
  let pulls = 0;
  pool.send = async (command, options) => {
    if ((command.cmd === 'PULL' || command.cmd === 'PULLB') && ++pulls <= refusals) {
      return { ok: false, error: message };
    }
    return send(command, options);
  };
}

/** Count `error` emits made while no listener is attached: each one ends the process. */
function countUnhandledErrors(worker: Worker): { count: number } {
  const unhandled = { count: 0 };
  const emit = worker.emit.bind(worker);
  worker.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (event === 'error' && worker.listenerCount('error') === 0) {
      unhandled.count++;
      return false;
    }
    return emit(event, ...args);
  }) as Worker['emit'];
  return unhandled;
}

describe('a lock-timeout pull refusal is transient', () => {
  test.each(LOCK_TIMEOUTS)('the %p refusal is classified as transient', (message) => {
    const response = { ok: false, error: message };
    expect(isTransientRefusal(response)).toBe(true);
    expect(new PullRefusedError('PULLB', response).transient).toBe(true);
  });

  test.each(LOCK_TIMEOUTS)(
    'a Worker without an error listener survives %p refusals and completes the job [tcp]',
    async (message) => {
      harness = await startHarness('worker-pull-lock-timeout', 'tcp');
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
      refusePulls(worker, 2, message);

      await queue.add('job', {});
      worker.run();
      await waitUntil(() => completed === 1, 'the job to complete after the refusals', 3_000);

      expect(unhandled.count).toBe(0);
    }
  );
});
