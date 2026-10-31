/**
 * Repro: a Simple Mode (`Bunqueue`) processor never learnt that its job ended
 * elsewhere. The Worker aborts the processor signal when the broker enforces a job
 * `timeout` and on `worker.cancelJob()`, but `Bunqueue` wrapped its processor as
 * `(job) => this.processJob(job)` and dropped that signal, so the documented
 * `app.getSignal(job.id)` stayed un-aborted and the processor kept running after the
 * broker had already timed the job out. A plain Worker processor sees both aborts.
 */
import { afterEach, expect, test } from 'bun:test';
import { Bunqueue, shutdownManager } from '../src/client';

let app: Bunqueue<unknown, unknown> | null = null;

afterEach(async () => {
  await app?.close(true);
  app = null;
  shutdownManager();
});

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await Bun.sleep(10);
  return check();
}

function startApp(name: string, onAbort: () => void, onStart: (jobId: string) => void) {
  const instance: Bunqueue<unknown, unknown> = new Bunqueue(name, {
    embedded: true,
    processor: async (job) => {
      instance.getSignal(job.id)?.addEventListener('abort', onAbort, { once: true });
      onStart(job.id);
      await Bun.sleep(1_000);
      return 'late';
    },
  });
  return instance;
}

test('a job timeout aborts the Bunqueue processor signal', async () => {
  let aborted = false;
  app = startApp(
    `repro-bq-timeout-${process.pid}`,
    () => (aborted = true),
    () => undefined
  );
  await app.add('slow', {}, { timeout: 200, attempts: 1 });
  expect(await waitFor(() => aborted)).toBe(true);
});

test('worker.cancelJob aborts the Bunqueue processor signal', async () => {
  let aborted = false;
  let started: string | null = null;
  app = startApp(
    `repro-bq-cancel-${process.pid}`,
    () => (aborted = true),
    (jobId) => (started = jobId)
  );
  await app.add('slow', {}, { attempts: 1 });
  expect(await waitFor(() => started !== null)).toBe(true);
  expect(app.worker.cancelJob(started!)).toBe(true);
  expect(await waitFor(() => aborted)).toBe(true);
});
