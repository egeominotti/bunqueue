/**
 * Repro: job setters reported "cannot change" differently in embedded and TCP mode.
 *
 * - Embedded Queue jobs (from `add` and `getJob`) passed object progress straight to the
 *   engine and threw `progress must be a number`, while the TCP job proxies sent it as 0
 *   plus a JSON message.
 * - `Queue.updateJobProgress` never validated: NaN threw embedded but was dropped over
 *   TCP (the reply was ignored), and a string or boolean silently became 0.
 * - `changeDelay` on a job it cannot change threw over TCP from flow and DLQ jobs but
 *   resolved embedded, and `Queue.changeJobDelay` and the Queue job objects ignored the
 *   reply in both modes. `updateData` threw over TCP and resolved embedded. `promote`
 *   on a job that is not delayed threw over TCP from flow and DLQ jobs and resolved
 *   everywhere else, and DLQ jobs threw for progress on a job that is not active.
 *
 * One behavior in both modes now: `updateData` throws the broker's message when the
 * job cannot be updated (the new data would be lost silently); `changeDelay`, `promote`
 * and progress on a job that is gone or no longer delayed or active resolve without
 * change (2.9.10's result for `changeDelay`); invalid arguments always throw, and any
 * progress value is stored as 2.9.10 stored it (repro-compat-job-commands.test.ts).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { UnrecoverableError, type Job } from '../src/client';
import { jobId } from '../src/domain/types/job';
import { CoreE2eHarness, type CoreE2eMode } from './core-e2e/support/harness';

let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    return `value: ${String(await promise)}`;
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const CANNOT_UPDATE = 'error: Job not found or cannot be updated';
const RESOLVED = 'value: undefined';

async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(10);
  }
  throw new Error('condition not reached');
}

describe.each(['embedded', 'tcp'] as const)('job setter outcomes (%s)', (mode: CoreE2eMode) => {
  test('progress: object progress, validation and replies', async () => {
    harness = await CoreE2eHarness.start(mode, 'setter-progress');
    const queue = harness.queue('setter-progress');
    const activeId = (await queue.add('active', {})).id;
    const broker = harness.brokerManager();
    const pulled = await until(async () => (await broker.pull(queue.name)) ?? undefined);
    expect(String(pulled.id)).toBe(activeId);
    const waiting = await queue.add('waiting', {});
    const fetched = (await queue.getJob(waiting.id)) as Job<unknown>;

    expect({
      addObject: await outcome(waiting.updateProgress({ pct: 5 } as unknown as number)),
      getJobObject: await outcome(fetched.updateProgress({ pct: 5 } as unknown as number)),
      queueNaN: await outcome(queue.updateJobProgress(activeId, Number.NaN)),
      queueString: await outcome(queue.updateJobProgress(activeId, '50' as unknown as number)),
      queueBoolean: await outcome(queue.updateJobProgress(activeId, true as unknown as number)),
      queueObject: await outcome(queue.updateJobProgress(activeId, { pct: 5 })),
      queueNotActive: await outcome(queue.updateJobProgress(waiting.id, 10)),
    }).toEqual({
      addObject: RESOLVED,
      getJobObject: RESOLVED,
      queueNaN: RESOLVED,
      queueString: RESOLVED,
      queueBoolean: RESOLVED,
      queueObject: RESOLVED,
      queueNotActive: RESOLVED,
    });
    expect(broker.getProgress(jobId(activeId))).toEqual({ progress: 0, message: '{"pct":5}' });
  });

  test('Queue and Queue jobs: updateData throws, changeDelay and promote resolve', async () => {
    harness = await CoreE2eHarness.start(mode, 'setter-queue');
    const queue = harness.queue('setter-queue');
    const gone = await queue.add('gone', {});
    await gone.remove();
    const waiting = await queue.add('waiting', {});
    expect({
      queueDelay: await outcome(queue.changeJobDelay(gone.id, 1_000)),
      queueUpdate: await outcome(queue.updateJobData(gone.id, { x: 1 })),
      queuePromote: await outcome(queue.promoteJob(waiting.id)),
      jobDelay: await outcome(gone.changeDelay(1_000)),
      jobUpdate: await outcome(gone.updateData({ x: 1 })),
      jobPromote: await outcome(waiting.promote()),
    }).toEqual({
      queueDelay: RESOLVED,
      queueUpdate: CANNOT_UPDATE,
      queuePromote: RESOLVED,
      jobDelay: RESOLVED,
      jobUpdate: CANNOT_UPDATE,
      jobPromote: RESOLVED,
    });
  });

  test('FlowProducer jobs: the same outcomes as Queue jobs', async () => {
    harness = await CoreE2eHarness.start(mode, 'setter-flow');
    const queue = harness.queue('setter-flow');
    const flow = harness.flow();
    const waiting = (await flow.add({ name: 'waiting', queueName: queue.name, data: {} })).job;
    const gone = (await flow.add({ name: 'gone', queueName: queue.name, data: {} })).job;
    await gone.remove();
    expect({
      delay: await outcome(gone.changeDelay(1_000)),
      update: await outcome(gone.updateData({ x: 1 })),
      promote: await outcome(waiting.promote()),
      progressNotActive: await outcome(waiting.updateProgress(10)),
    }).toEqual({
      delay: RESOLVED,
      update: CANNOT_UPDATE,
      promote: RESOLVED,
      progressNotActive: RESOLVED,
    });
  });

  test('DLQ jobs: the same outcomes as Queue jobs', async () => {
    harness = await CoreE2eHarness.start(mode, 'setter-dlq');
    const queue = harness.queue('setter-dlq');
    await queue.add('task', {}, { attempts: 1 });
    harness.worker(queue.name, () => {
      throw new UnrecoverableError('to the DLQ');
    });
    const entry = await until(async () => (await queue.getDlqAsync())[0]);
    const job = entry.job as Job<unknown>;
    expect({
      delay: await outcome(job.changeDelay(1_000)),
      update: await outcome(job.updateData({ x: 1 })),
      promote: await outcome(job.promote()),
      progressNotActive: await outcome(job.updateProgress(10)),
    }).toEqual({
      delay: RESOLVED,
      update: CANNOT_UPDATE,
      promote: RESOLVED,
      progressNotActive: RESOLVED,
    });
  });
});
