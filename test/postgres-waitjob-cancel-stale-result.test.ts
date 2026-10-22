/**
 * Issue #162: on PostgreSQL, WaitJob must not answer with the result of a completion
 * that `Cancel` removed before the WaitJob started.
 *
 * PostgreSQL delivers journal events after their commit, so the `completed` event of an
 * ACK can reach a broker after a later `Cancel` removed the completed job and cleared
 * the result in its completion record. WaitJob captures `completed` events while it
 * reads the job; it used to answer with the captured event's result instead of the
 * record's, which no longer holds one. Each test pauses the broker's event stream, so
 * nothing is delivered on its own, and delivers the held events exactly while WaitJob
 * reads: no timing is involved. A completion that was not removed still answers its
 * result through the same path.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { PostgresQueueManager } from '../src/application/postgresQueueManager';
import type { JobId } from '../src/domain/types/job';
import { EventType } from '../src/domain/types/queue';
import { handleCommand } from '../src/infrastructure/server/handler';
import type { HandlerContext } from '../src/infrastructure/server/types';
import {
  cleanupPostgresNamespace,
  eventually,
  pausePostgresEventStream,
  postgresEventStream,
  postgresManagerStore,
} from './support/postgres-event-race';

const postgresUrl = Bun.env.BUNQUEUE_TEST_POSTGRES_URL;
const namespaces: string[] = [];

function namespace(label: string): string {
  const value = `test-waitjob-cancel-${label}-${Date.now()}-${crypto.randomUUID()}`;
  namespaces.push(value);
  return value;
}

function broker(value: string, brokerId: string): PostgresQueueManager {
  return new PostgresQueueManager({
    postgres: { url: postgresUrl!, namespace: value, brokerId, pollIntervalMs: 25 },
  });
}

function context(manager: PostgresQueueManager): HandlerContext {
  return {
    queueManager: manager,
    authTokens: new Set<string>(),
    authenticated: false,
    clientId: 'waitjob-cancel',
  };
}

/** Deliver every committed event, then stop all further delivery. */
async function pauseCaughtUp(manager: PostgresQueueManager): Promise<void> {
  const stream = postgresEventStream(manager);
  const store = postgresManagerStore(manager);
  expect(await eventually(async () => stream.cursor >= (await store.latestEventId()))).toBe(true);
  await pausePostgresEventStream(manager);
}

/** Count the `completed` events `manager` broadcasts for `id`. */
function countCompletedEvents(manager: PostgresQueueManager, id: JobId): { delivered: number } {
  const counter = { delivered: 0 };
  manager.subscribe((event) => {
    if (event.eventType === EventType.Completed && event.jobId === id) counter.delivered++;
  });
  return counter;
}

/** Complete one job through `worker` with `result`; returns its ID. */
async function completeJob(
  producer: PostgresQueueManager,
  worker: PostgresQueueManager,
  queue: string,
  result: unknown
): Promise<JobId> {
  const job = await producer.push(queue, { data: { secret: 'payload' } });
  const claimed = await worker.pullWithLock(queue, 'waitjob-cancel-worker');
  expect(claimed.job?.id).toBe(job.id);
  await worker.ack(job.id, result, claimed.token!);
  return job.id;
}

/**
 * Run `read` once for `id`, then deliver the events `manager` holds before it returns:
 * the held `completed` event reaches WaitJob while it waits on that read.
 */
function deliverDuringRead<T>(
  manager: PostgresQueueManager,
  id: JobId,
  read: (id: JobId) => Promise<T>
): (id: JobId) => Promise<T> {
  let delivered = false;
  return async (requested) => {
    const value = await read(requested);
    if (!delivered && String(requested) === String(id)) {
      delivered = true;
      await postgresEventStream(manager).drain();
    }
    return value;
  };
}

afterAll(async () => {
  if (!postgresUrl) return;
  for (const value of namespaces) await cleanupPostgresNamespace(postgresUrl, value);
});

describe('PostgreSQL WaitJob after Cancel removed a completed job (#162)', () => {
  test.skipIf(!postgresUrl)(
    'a completed event delivered during the job read does not answer its result',
    async () => {
      const manager = broker(namespace('job-read'), 'waitjob-cancel-job-read');
      try {
        await manager.waitUntilReady();
        await pauseCaughtUp(manager);
        const id = await completeJob(manager, manager, 'waitjob-cancel', { answer: 4 });
        expect(await manager.cancel(id)).toBe(true);
        const events = countCompletedEvents(manager, id);
        expect(events.delivered).toBe(0);
        manager.getJob = deliverDuringRead(manager, id, manager.getJob.bind(manager));

        const reply = await handleCommand(
          { cmd: 'WaitJob', id: String(id), timeout: 100 },
          context(manager)
        );

        expect(events.delivered).toBe(1);
        expect(reply).toMatchObject({ ok: true, completed: true });
        expect((reply as { result?: unknown }).result).toBeUndefined();
      } finally {
        await manager.shutdownPostgres();
      }
    }
  );

  test.skipIf(!postgresUrl)(
    'a completed event delivered during the completion lookup does not answer its result',
    async () => {
      const manager = broker(namespace('lookup'), 'waitjob-cancel-lookup');
      try {
        await manager.waitUntilReady();
        await pauseCaughtUp(manager);
        const id = await completeJob(manager, manager, 'waitjob-cancel', { answer: 5 });
        expect(await manager.cancel(id)).toBe(true);
        const events = countCompletedEvents(manager, id);
        manager.getCompletionAsync = deliverDuringRead(
          manager,
          id,
          manager.getCompletionAsync.bind(manager)
        );

        const reply = await handleCommand(
          { cmd: 'WaitJob', id: String(id), timeout: 100 },
          context(manager)
        );

        expect(events.delivered).toBe(1);
        expect(reply).toMatchObject({ ok: true, completed: true });
        expect((reply as { result?: unknown }).result).toBeUndefined();
      } finally {
        await manager.shutdownPostgres();
      }
    }
  );

  test.skipIf(!postgresUrl)(
    'a broker that receives the completed event late answers without the removed result',
    async () => {
      const value = namespace('remote');
      const owner = broker(value, 'waitjob-cancel-owner');
      const waiter = broker(value, 'waitjob-cancel-waiter');
      try {
        await Promise.all([owner.waitUntilReady(), waiter.waitUntilReady()]);
        await pauseCaughtUp(waiter);
        const id = await completeJob(owner, owner, 'waitjob-cancel-remote', { answer: 6 });
        expect(await owner.cancel(id)).toBe(true);
        const events = countCompletedEvents(waiter, id);
        waiter.getJob = deliverDuringRead(waiter, id, waiter.getJob.bind(waiter));

        const reply = await handleCommand(
          { cmd: 'WaitJob', id: String(id), timeout: 100 },
          context(waiter)
        );

        expect(events.delivered).toBe(1);
        expect(reply).toMatchObject({ ok: true, completed: true });
        expect((reply as { result?: unknown }).result).toBeUndefined();
      } finally {
        await Promise.all([owner.shutdownPostgres(), waiter.shutdownPostgres()]);
      }
    }
  );

  for (const removeOnComplete of [false, true]) {
    test.skipIf(!postgresUrl)(
      `a completion that was not removed still answers its result (removeOnComplete: ${removeOnComplete})`,
      async () => {
        const manager = broker(namespace(`kept-${removeOnComplete}`), 'waitjob-cancel-kept');
        try {
          await manager.waitUntilReady();
          await pauseCaughtUp(manager);
          const job = await manager.push('waitjob-kept', { data: {}, removeOnComplete });
          const claimed = await manager.pullWithLock('waitjob-kept', 'waitjob-kept-worker');
          expect(claimed.job?.id).toBe(job.id);
          await manager.ack(job.id, { answer: 7 }, claimed.token!);
          const events = countCompletedEvents(manager, job.id);
          manager.getJob = deliverDuringRead(manager, job.id, manager.getJob.bind(manager));

          const reply = await handleCommand(
            { cmd: 'WaitJob', id: String(job.id), timeout: 100 },
            context(manager)
          );

          expect(events.delivered).toBe(1);
          expect(reply).toMatchObject({ ok: true, completed: true, result: { answer: 7 } });
        } finally {
          await manager.shutdownPostgres();
        }
      }
    );
  }
});
