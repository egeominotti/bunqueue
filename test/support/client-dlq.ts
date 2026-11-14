/** Shared helpers for the test/client-dlq-dedup-*.test.ts files. */
import { Queue, Worker } from '../../src/client';

/** Poll real state; a missing fixture is an explicit failure, never an empty result. */
export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline)
      throw new Error(`DLQ fixture did not reach expected state within ${timeoutMs}ms`);
    await Bun.sleep(10);
  }
}

export const inDlq = (queue: Queue<Record<string, unknown>>, id: string) => () =>
  queue.getDlq().some((entry) => entry.job.id === id);

/**
 * Helper: add a job and process it through a worker that always fails,
 * causing the job to land in the DLQ after exhausting all attempts.
 */
export async function addAndFailJob(
  queue: Queue<Record<string, unknown>>,
  queueName: string,
  data: Record<string, unknown>,
  opts: { attempts?: number; delay?: number } = {}
): Promise<string> {
  const job = await queue.add('fail-task', data, {
    attempts: opts.attempts ?? 1,
    backoff: 0,
    ...(opts.delay !== undefined ? { delay: opts.delay } : {}),
  });

  const worker = new Worker(
    queueName,
    async () => {
      throw new Error('intentional failure');
    },
    { concurrency: 1 }
  );

  // Wait for the job to exhaust attempts and land in DLQ
  try {
    await waitFor(inDlq(queue, job.id));
  } finally {
    await worker.close();
  }

  return job.id;
}
