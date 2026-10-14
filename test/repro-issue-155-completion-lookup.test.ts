/** Issue #155: late WaitJob registration and bounded caches must not lose results. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import { Queue } from '../src/client';
import { handleCommand } from '../src/infrastructure/server/handler';
import { createTcpServer } from '../src/infrastructure/server/tcp';
import type { HandlerContext } from '../src/infrastructure/server/types';

let manager: QueueManager | undefined;
let directory: string | undefined;

afterEach(() => {
  manager?.shutdown();
  manager = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function context(queueManager: QueueManager): HandlerContext {
  return { queueManager, authTokens: new Set<string>(), authenticated: false };
}

test('WaitJob sees a removed completion between its job read and waiter registration', async () => {
  manager = new QueueManager();
  const qm = manager;
  const job = await qm.push('i155-registration', { data: {}, removeOnComplete: true });
  await qm.pull(job.queue);
  const getJob = qm.getJob.bind(qm);
  let intercepted = false;
  // Force the legal interleaving: the async job read has captured the active job,
  // then ACK commits and broadcasts before WaitJob can register its event waiter.
  qm.getJob = async (id) => {
    const captured = await getJob(id);
    if (!intercepted && id === job.id) {
      intercepted = true;
      await qm.ack(id, { answer: 42 });
    }
    return captured;
  };

  const reply = await handleCommand({ cmd: 'WaitJob', id: job.id, timeout: 0 }, context(qm));
  expect(reply).toMatchObject({ ok: true, completed: true, result: { answer: 42 } });
  expect(await getJob(job.id)).toBeNull();
  expect(qm.getStats().totalCompleted).toBe(1n);
});

test('SQLite completion results survive eviction from the bounded completed cache', async () => {
  directory = mkdtempSync(join(tmpdir(), 'bunqueue-i155-lookup-'));
  manager = new QueueManager({ dataPath: join(directory, 'queue.db'), maxCompletedJobs: 1 });
  const qm = manager;
  const first = await qm.push('i155-eviction', { data: { secret: 'first' }, durable: true });
  await qm.pull(first.queue);
  await qm.ack(first.id, { answer: 1 });
  const second = await qm.push(first.queue, { data: {}, durable: true });
  await qm.pull(second.queue);
  await qm.ack(second.id, { answer: 2 });
  qm.flushPersistence();

  expect(await qm.getJobState(first.id)).toBe('completed');
  expect(await qm.getCompletionAsync(first.id)).toEqual({ found: true, result: { answer: 1 } });
  expect(await qm.getResultAsync(first.id)).toEqual({ answer: 1 });
  expect(
    await handleCommand({ cmd: 'WaitJob', id: first.id, timeout: 0 }, context(qm))
  ).toMatchObject({ ok: true, completed: true, result: { answer: 1 } });
  const server = createTcpServer(qm, { hostname: '127.0.0.1', port: 0 });
  const queue = new Queue(first.queue, {
    embedded: false,
    connection: { host: '127.0.0.1', port: server.server.port, poolSize: 1 },
    autoBatch: { enabled: false },
  });
  try {
    const job = await queue.getJob(first.id);
    expect(job).toBeTruthy();
    expect(await job!.waitUntilFinished(null, 5_000)).toEqual({ answer: 1 });
    await job!.remove();
    expect(await queue.getJob(first.id)).toBeFalsy();
  } finally {
    await queue.close();
    server.stop();
  }
  expect(await qm.getCompletionAsync(first.id)).toEqual({ found: false, result: undefined });
});
