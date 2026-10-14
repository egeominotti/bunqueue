/** Issue #155: a completion must not fall between WaitJob's read and its hold. */
import { afterEach, expect, test } from 'bun:test';
import { EventsManager } from '../src/application/eventsManager';
import { QueueManager, type QueueManagerConfig } from '../src/application/queueManager';
import { handleCommand } from '../src/infrastructure/server/handler';
import type { HandlerContext } from '../src/infrastructure/server/types';

let manager: QueueManager | undefined;
const subscriberBaselines = new WeakMap<QueueManager, number>();

afterEach(() => {
  manager?.shutdown();
  manager = undefined;
});

function context(queueManager: QueueManager): HandlerContext {
  return { queueManager, authTokens: new Set<string>(), authenticated: false };
}

function eventsOf(queueManager: QueueManager): EventsManager {
  return (queueManager as unknown as { eventsManager: EventsManager }).eventsManager;
}

function createManager(config?: QueueManagerConfig): QueueManager {
  manager = new QueueManager(config);
  subscriberBaselines.set(manager, eventsOf(manager).subscriberCount);
  return manager;
}

function expectClean(queueManager: QueueManager): void {
  expect(eventsOf(queueManager).subscriberCount).toBe(subscriberBaselines.get(queueManager));
  expect(eventsOf(queueManager).completionWaiterCount).toBe(0);
}

for (const result of [{ answer: 42 }, undefined, null, false, 0, '']) {
  test(`captures a completion during the initial job read without retained results: ${JSON.stringify(result)}`, async () => {
    const qm = createManager({ removedResultRetentionMs: 0 });
    const job = await qm.push('i155-read-gap', { data: {}, removeOnComplete: true });
    await qm.pull(job.queue);
    const getJob = qm.getJob.bind(qm);
    let intercepted = false;
    qm.getJob = async (id) => {
      const captured = await getJob(id);
      if (!intercepted && id === job.id) {
        intercepted = true;
        await qm.ack(id, result);
      }
      return captured;
    };

    const reply = await handleCommand({ cmd: 'WaitJob', id: job.id, timeout: 0 }, context(qm));

    expect(reply).toMatchObject({ ok: true, completed: true, result });
    expect(await getJob(job.id)).toBeNull();
    expect(await qm.getCompletionAsync(job.id)).toEqual({ found: false, result: undefined });
    expect(qm.getStats().totalCompleted).toBe(1n);
    expectClean(qm);
  });
}

test('captures a completion while a missing-job completion lookup is pending', async () => {
  const qm = createManager({ removedResultRetentionMs: 0 });
  const job = await qm.push('i155-completion-read-gap', { data: {}, removeOnComplete: true });
  await qm.pull(job.queue);
  qm.getJob = async () => null;
  qm.getCompletionAsync = async (id) => {
    await qm.ack(id, { answer: 5 });
    return { found: false, result: undefined };
  };

  const reply = await handleCommand({ cmd: 'WaitJob', id: job.id, timeout: 0 }, context(qm));

  expect(reply).toMatchObject({ ok: true, completed: true, result: { answer: 5 } });
  expect(qm.getStats().totalCompleted).toBe(1n);
  expectClean(qm);
});

test('the capture hands off to the completion waiter without retaining subscribers', async () => {
  const qm = createManager({ removedResultRetentionMs: 0 });
  const job = await qm.push('i155-handoff', { data: {}, removeOnComplete: true });
  await qm.pull(job.queue);
  const waiting = handleCommand({ cmd: 'WaitJob', id: job.id, timeout: 5_000 }, context(qm));
  for (let attempt = 0; eventsOf(qm).completionWaiterCount === 0; attempt++) {
    if (attempt > 500) throw new Error('WaitJob hold was not registered');
    await Bun.sleep(1);
  }
  expect(eventsOf(qm).subscriberCount).toBe(subscriberBaselines.get(qm));

  await qm.ack(job.id, { answer: 6 });

  expect(await waiting).toMatchObject({ ok: true, completed: true, result: { answer: 6 } });
  expectClean(qm);
});

test('a failed initial job read releases its temporary subscriber', async () => {
  const qm = createManager();
  qm.getJob = async () => {
    throw new Error('Initial job read failed');
  };

  expect(
    await handleCommand({ cmd: 'WaitJob', id: 'missing', timeout: 5_000 }, context(qm))
  ).toMatchObject({ ok: false, error: 'Initial job read failed' });
  expectClean(qm);
});

test('a failed completion read releases its temporary subscriber', async () => {
  const qm = createManager();
  qm.getCompletionAsync = async () => {
    throw new Error('Completion read failed');
  };

  expect(
    await handleCommand({ cmd: 'WaitJob', id: 'missing', timeout: 5_000 }, context(qm))
  ).toMatchObject({ ok: false, error: 'Completion read failed' });
  expectClean(qm);
});

test('a failed waiter registration releases its temporary subscriber', async () => {
  const qm = createManager();
  const job = await qm.push('i155-registration-error', { data: {} });
  qm.waitForJobResult = () => {
    throw new Error('Waiter registration failed');
  };

  expect(
    await handleCommand({ cmd: 'WaitJob', id: job.id, timeout: 5_000 }, context(qm))
  ).toMatchObject({ ok: false, error: 'Waiter registration failed' });
  expectClean(qm);
});

test('another job completing during the read cannot satisfy the requested job', async () => {
  const qm = createManager({ removedResultRetentionMs: 0 });
  const first = await qm.push('i155-other-event', { data: {}, removeOnComplete: true });
  const second = await qm.push(first.queue, { data: {} });
  await qm.pull(first.queue);
  const getJob = qm.getJob.bind(qm);
  let intercepted = false;
  qm.getJob = async (id) => {
    const captured = await getJob(id);
    if (!intercepted && id === second.id) {
      intercepted = true;
      await qm.ack(first.id, 'other result');
    }
    return captured;
  };

  const reply = await handleCommand({ cmd: 'WaitJob', id: second.id, timeout: 0 }, context(qm));

  expect(reply).toMatchObject({ ok: true, completed: false });
  expect(await qm.getJobState(second.id)).toBe('waiting');
  expectClean(qm);
});

test('a stale completed snapshot cannot complete a new waiting custom-ID generation', async () => {
  const qm = createManager();
  const job = await qm.push('i155-reused-completed', {
    data: { generation: 1 },
    customId: 'i155-reused-request',
  });
  await qm.pull(job.queue);
  await qm.ack(job.id, { answer: 'old generation' });
  const getJob = qm.getJob.bind(qm);
  let intercepted = false;
  qm.getJob = async (id) => {
    const captured = await getJob(id);
    if (!intercepted && id === job.id) {
      intercepted = true;
      await qm.push(job.queue, {
        data: { generation: 2 },
        customId: 'i155-reused-request',
      });
    }
    return captured;
  };

  const reply = await handleCommand({ cmd: 'WaitJob', id: job.id, timeout: 0 }, context(qm));

  expect(reply).toMatchObject({ ok: true, completed: false });
  expect(await qm.getJobState(job.id)).toBe('waiting');
  expect((await getJob(job.id))?.data).toEqual({ generation: 2 });
  expect(qm.getStats().totalCompleted).toBe(1n);
  expectClean(qm);
});

test('invalid timeouts and missing jobs leave no capture or completion waiter', async () => {
  const qm = createManager();

  expect(
    await handleCommand({ cmd: 'WaitJob', id: 'missing', timeout: -1 }, context(qm))
  ).toMatchObject({ ok: false });
  expectClean(qm);
  expect(
    await handleCommand({ cmd: 'WaitJob', id: 'missing', timeout: 0 }, context(qm))
  ).toMatchObject({ ok: false, error: 'Job not found' });
  expectClean(qm);
});
