/**
 * Repro for GitHub issue #155 A, at the broker: a completion wait must answer with the
 * result carried by the `completed` event that wakes it.
 *
 * A WaitJob hold woke on the job's `completed` event, dropped the event, then re-read
 * the result from `completedJobs`/SQLite. A job removed on completion keeps nothing
 * there, so the hold answered `{ completed: true, result: undefined }` although the
 * event that woke it carried the worker's return value. The event's data now reaches
 * the waiter (`EventsManager.waitForJobOutcome`, `QueueManager.waitForJobResult`) and
 * WaitJob answers with it, on the single ACK, batch ACK and stall-retried ACK paths.
 *
 * Unchanged: a completion the wait missed still reads as `Job not found` for a job
 * removed on completion (no result is retained), a timeout answers `completed: false`,
 * and a waiter released without an event (shutdown) reads the stored result.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { EventsManager } from '../src/application/eventsManager';
import { QueueManager } from '../src/application/queueManager';
import { WebhookManager } from '../src/application/webhookManager';
import { jobId, type JobId } from '../src/domain/types/job';
import { EventType, type JobEvent } from '../src/domain/types/queue';
import type { Response } from '../src/domain/types/response';
import { handleCommand } from '../src/infrastructure/server/handler';
import type { HandlerContext } from '../src/infrastructure/server/types';

let qm: QueueManager | null = null;

afterEach(() => {
  qm?.shutdown();
  qm = null;
});

function completedEvent(id: string, data: unknown): JobEvent {
  return { eventType: EventType.Completed, queue: 'q', jobId: id, timestamp: Date.now(), data };
}

function eventsOf(manager: QueueManager): EventsManager {
  return (manager as unknown as { eventsManager: EventsManager }).eventsManager;
}

function context(manager: QueueManager): HandlerContext {
  return { queueManager: manager, authTokens: new Set<string>(), authenticated: false };
}

/** An active job added with `removeOnComplete`, pulled without a lease. */
async function activeRemovedOnComplete(manager: QueueManager, queue: string): Promise<JobId> {
  await manager.push(queue, { data: { n: 1 }, removeOnComplete: true, maxAttempts: 3, backoff: 0 });
  const pulled = await manager.pull(queue);
  if (!pulled) throw new Error('no job pulled');
  return pulled.id;
}

/** Start a WaitJob hold and return its pending reply once the broker has registered it. */
async function holdWaitJob(
  manager: QueueManager,
  id: JobId
): Promise<{ reply: Promise<Response> }> {
  const reply = handleCommand({ cmd: 'WaitJob', id: String(id), timeout: 5_000 }, context(manager));
  for (let attempt = 0; eventsOf(manager).completionWaiterCount === 0; attempt++) {
    if (attempt > 500) throw new Error('WaitJob hold not registered');
    await Bun.sleep(1);
  }
  return { reply };
}

describe('EventsManager.waitForJobOutcome', () => {
  test('resolves with the data of the completed event that wakes it', async () => {
    const events = new EventsManager(new WebhookManager());
    const waiting = events.waitForJobOutcome(jobId('job-1'), 5_000);

    events.broadcast(completedEvent('job-1', { answer: 2 }));

    expect(await waiting).toEqual({ completed: true, fromEvent: true, result: { answer: 2 } });
    expect(events.completionWaiterCount).toBe(0);
  });

  test('a batch broadcast hands each waiter its own job result', async () => {
    const events = new EventsManager(new WebhookManager());
    const first = events.waitForJobOutcome(jobId('job-a'), 5_000);
    const second = events.waitForJobOutcome(jobId('job-b'), 5_000);
    const boolean = events.waitForJobCompletion(jobId('job-b'), 5_000);

    events.broadcastBatch([completedEvent('job-a', 1), completedEvent('job-b', { answer: 4 })]);

    expect(await first).toEqual({ completed: true, fromEvent: true, result: 1 });
    expect(await second).toEqual({ completed: true, fromEvent: true, result: { answer: 4 } });
    expect(await boolean).toBe(true);
    expect(events.completionWaiterCount).toBe(0);
  });

  test('other events with data do not wake the waiter', async () => {
    const events = new EventsManager(new WebhookManager());
    const waiting = events.waitForJobOutcome(jobId('job-2'), 30);

    events.broadcast({ ...completedEvent('job-2', 'x'), eventType: EventType.Failed });
    events.broadcast({ ...completedEvent('job-2', 'x'), eventType: EventType.Progress });

    expect(await waiting).toEqual({ completed: false });
    expect(events.completionWaiterCount).toBe(0);
  });

  test('a timeout or an abort settles as not completed and leaves no waiter', async () => {
    const events = new EventsManager(new WebhookManager());
    const controller = new AbortController();
    const aborted = events.waitForJobOutcome(jobId('job-3'), 30_000, controller.signal);
    const timedOut = events.waitForJobOutcome(jobId('job-4'), 0);
    controller.abort();

    expect(await aborted).toEqual({ completed: false });
    expect(await timedOut).toEqual({ completed: false });
    expect(events.completionWaiterCount).toBe(0);
    expect(events.needsBroadcast()).toBe(false);
  });

  test('a waiter released at shutdown has no event to carry', async () => {
    const events = new EventsManager(new WebhookManager());
    const waiting = events.waitForJobOutcome(jobId('job-5'), 30_000);

    events.clear();

    expect(await waiting).toEqual({ completed: true, fromEvent: false });
  });

  test('an invalid timeout throws synchronously, naming the result wait', () => {
    const events = new EventsManager(new WebhookManager());
    expect(() => events.waitForJobOutcome(jobId('job-6'), -1)).toThrow(
      'QueueManager.waitForJobResult: timeoutMs'
    );
    expect(events.completionWaiterCount).toBe(0);
  });
});

describe('QueueManager.waitForJobResult', () => {
  test('returns the result of a job removed on completion (single ACK)', async () => {
    qm = new QueueManager();
    const id = await activeRemovedOnComplete(qm, 'wr-ack');
    const waiting = qm.waitForJobResult(id, 5_000);

    await qm.ack(id, { answer: 2 });

    expect(await waiting).toEqual({ completed: true, result: { answer: 2 } });
    // Nothing is retained: only the waiter registered at completion gets the result.
    expect(await qm.getCompletionAsync(id)).toEqual({ found: false, result: undefined });
  });

  test('returns the result of a job removed on completion (batch ACK)', async () => {
    qm = new QueueManager();
    const other = await activeRemovedOnComplete(qm, 'wr-ackb');
    const id = await activeRemovedOnComplete(qm, 'wr-ackb');
    const waiting = qm.waitForJobResult(id, 5_000);

    await qm.ackBatchWithResults([
      { id: other, result: { answer: 1 } },
      { id, result: { answer: 4 } },
    ]);

    expect(await waiting).toEqual({ completed: true, result: { answer: 4 } });
  });

  test('returns the result of a stall-retried job completed by a late ACK', async () => {
    qm = new QueueManager();
    const id = await activeRemovedOnComplete(qm, 'wr-stall');
    // The job is back in the queue with one attempt spent, as a stall retry leaves it.
    await qm.fail(id, 'transient');
    expect(await qm.getJobState(id)).toBe('waiting');
    const waiting = qm.waitForJobResult(id, 5_000);

    await qm.ack(id, { late: true });

    expect(await waiting).toEqual({ completed: true, result: { late: true } });
    expect(await qm.getJobState(id)).toBe('unknown');
  });

  test('a released waiter without an event reads the stored result', async () => {
    qm = new QueueManager();
    await qm.push('wr-shutdown', { data: {} });
    const pulled = await qm.pull('wr-shutdown');
    await qm.ack(pulled!.id, { kept: 1 });
    // Already completed: no event will wake this waiter, the release below does.
    const waiting = qm.waitForJobResult(pulled!.id, 30_000);

    eventsOf(qm).clear();

    expect(await waiting).toEqual({ completed: true, result: { kept: 1 } });
  });

  test('a timeout answers not completed without a result', async () => {
    qm = new QueueManager();
    const id = await activeRemovedOnComplete(qm, 'wr-timeout');

    expect(await qm.waitForJobResult(id, 10)).toEqual({ completed: false, result: undefined });
  });
});

describe('WaitJob for a job removed on completion', () => {
  test('a hold registered when the job completes answers with its result', async () => {
    qm = new QueueManager();
    const id = await activeRemovedOnComplete(qm, 'wj-ack');
    const { reply } = await holdWaitJob(qm, id);

    await qm.ack(id, { answer: 2 });

    expect(await reply).toMatchObject({ ok: true, completed: true, result: { answer: 2 } });
  });

  test('a batch ACK answers each hold with its own result', async () => {
    qm = new QueueManager();
    const other = await activeRemovedOnComplete(qm, 'wj-ackb');
    const id = await activeRemovedOnComplete(qm, 'wj-ackb');
    const { reply } = await holdWaitJob(qm, id);

    await qm.ackBatchWithResults([
      { id: other, result: { answer: 1 } },
      { id, result: { answer: 4 } },
    ]);

    expect(await reply).toMatchObject({ ok: true, completed: true, result: { answer: 4 } });
  });

  test('a completion the hold missed still reads as not found', async () => {
    qm = new QueueManager();
    const id = await activeRemovedOnComplete(qm, 'wj-missed');
    await qm.ack(id, { answer: 2 });

    expect(
      await handleCommand({ cmd: 'WaitJob', id: String(id), timeout: 100 }, context(qm))
    ).toMatchObject({ ok: false, error: 'Job not found' });
  });
});
