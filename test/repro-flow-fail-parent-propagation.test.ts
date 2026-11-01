/**
 * A parent that `failParentOnFailure` moves to `failed` has itself failed terminally,
 * so its own flow policy toward its parent must apply too (docs: guide/flow/failures,
 * "when a child fails terminally"; BullMQ propagates failParentOnFailure recursively).
 *
 * Before the fix: gp <- mid(failParentOnFailure) <- leaf(failParentOnFailure). When
 * leaf fails, mid goes to the DLQ ("Child job <leaf> failed: ...") but gp stays in
 * `waiting-children` forever.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FlowProducer, Queue, Worker, shutdownManager } from '../src/client';

type Policy =
  | 'failParentOnFailure'
  | 'ignoreDependencyOnFailure'
  | 'removeDependencyOnFailure'
  | 'continueParentOnFailure';

const QUEUE = 'fpof-propagation';
const directories: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  shutdownManager();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runtime(): { embedded: true; dataPath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'bunqueue-fpof-propagation-'));
  directories.push(directory);
  return { embedded: true, dataPath: join(directory, 'queue.db') };
}

async function waitForState(
  queue: Queue,
  id: string,
  matches: (state: string) => boolean,
  timeoutMs = 5_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let state = await queue.getJobState(id);
  while (!matches(state) && Date.now() < deadline) {
    await Bun.sleep(20);
    state = await queue.getJobState(id);
  }
  return state;
}

/** gp <- mid(midPolicy) <- leaf(failParentOnFailure, fails) + a sibling that never runs. */
async function run(midPolicy: Policy | null) {
  const options = runtime();
  const queue = new Queue(QUEUE, options);
  const flow = new FlowProducer({ embedded: true });
  cleanups.push(
    () => queue.close(),
    () => flow.close()
  );
  const node = await flow.add({
    name: 'gp',
    queueName: QUEUE,
    data: {},
    children: [
      {
        name: 'mid',
        queueName: QUEUE,
        data: {},
        opts: midPolicy ? { [midPolicy]: true } : {},
        children: [
          {
            name: 'leaf',
            queueName: QUEUE,
            data: {},
            opts: { failParentOnFailure: true, attempts: 1 },
          },
          { name: 'sibling', queueName: QUEUE, data: {}, opts: { delay: 60_000 } },
        ],
      },
    ],
  });
  const ran: string[] = [];
  const worker = new Worker(
    QUEUE,
    async (job) => {
      ran.push(job.name);
      if (job.name === 'leaf') throw new Error('boom');
      return { ok: job.name };
    },
    options
  );
  cleanups.push(() => worker.close());
  const mid = node.children![0];
  const leafId = mid.children![0].job.id;
  expect(await waitForState(queue, leafId, (s) => s === 'failed')).toBe('failed');
  expect(await waitForState(queue, mid.job.id, (s) => s === 'failed')).toBe('failed');
  return { queue, gpId: node.job.id, midId: mid.job.id, ran };
}

describe('a parent failed by failParentOnFailure applies its own policy', () => {
  test('failParentOnFailure on the middle node fails the grandparent', async () => {
    const { queue, gpId, ran } = await run('failParentOnFailure');
    expect(await waitForState(queue, gpId, (s) => s === 'failed')).toBe('failed');
    expect(ran).not.toContain('gp');
  }, 15_000);

  test('ignoreDependencyOnFailure on the middle node releases the grandparent', async () => {
    const { queue, gpId, ran } = await run('ignoreDependencyOnFailure');
    expect(await waitForState(queue, gpId, (s) => s === 'completed')).toBe('completed');
    expect(ran).toContain('gp');
  }, 15_000);

  test('removeDependencyOnFailure on the middle node releases the grandparent', async () => {
    const { queue, gpId, ran } = await run('removeDependencyOnFailure');
    expect(await waitForState(queue, gpId, (s) => s === 'completed')).toBe('completed');
    expect(ran).toContain('gp');
  }, 15_000);

  test('continueParentOnFailure on the middle node promotes the grandparent', async () => {
    const { queue, gpId, ran } = await run('continueParentOnFailure');
    expect(await waitForState(queue, gpId, (s) => s === 'completed')).toBe('completed');
    expect(ran).toContain('gp');
  }, 15_000);

  test('control: without a policy on the middle node the grandparent keeps waiting', async () => {
    const { queue, gpId } = await run(null);
    await Bun.sleep(300);
    expect(await queue.getJobState(gpId)).toBe('waiting-children');
  }, 15_000);

  test('failParentOnFailure propagates through four levels', async () => {
    const options = runtime();
    const queue = new Queue(QUEUE, options);
    const flow = new FlowProducer({ embedded: true });
    cleanups.push(
      () => queue.close(),
      () => flow.close()
    );
    const fpof = { failParentOnFailure: true };
    const node = await flow.add({
      name: 'root',
      queueName: QUEUE,
      data: {},
      children: [
        {
          name: 'l1',
          queueName: QUEUE,
          data: {},
          opts: fpof,
          children: [
            {
              name: 'l2',
              queueName: QUEUE,
              data: {},
              opts: fpof,
              children: [
                { name: 'leaf', queueName: QUEUE, data: {}, opts: { ...fpof, attempts: 1 } },
              ],
            },
          ],
        },
      ],
    });
    const worker = new Worker(
      QUEUE,
      async (job) => {
        if (job.name === 'leaf') throw new Error('boom');
        return null;
      },
      options
    );
    cleanups.push(() => worker.close());
    expect(await waitForState(queue, node.job.id, (s) => s === 'failed')).toBe('failed');
    const l1 = node.children![0];
    expect(await queue.getJobState(l1.job.id)).toBe('failed');
    expect(await queue.getJobState(l1.children![0].job.id)).toBe('failed');
  }, 15_000);
});
