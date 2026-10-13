/**
 * Repro (model seed 418721315, path 108, size `max`): a queue concurrency limit set while
 * jobs of that queue are already active did not count them.
 *
 * Minimized history: push a → pull a (no limit) → setConcurrency(2) → push b, c →
 * pullBatch(2) returned both b and c, leaving three active jobs under a limit of two.
 * `LimiterManager.setConcurrency` created a fresh limiter whose active count started at
 * zero whatever was already running; BullMQ counts the whole active list toward the
 * global concurrency. The same gap let a job that was active before the limit release a
 * slot it never held, and let clear-then-set forget the running jobs.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';

let manager: QueueManager | null = null;

afterEach(() => {
  manager?.shutdown();
  manager = null;
});

function start(): QueueManager {
  manager = new QueueManager();
  return manager;
}

async function push(m: QueueManager, queue: string, n: number) {
  return m.push(queue, { data: { n } });
}

describe('a concurrency limit counts the jobs already active when it is set', () => {
  test('setConcurrency(2) with one active job admits only one more', async () => {
    const m = start();
    const queue = 'limit-after-active';
    await push(m, queue, 1);
    expect(await m.pull(queue)).not.toBeNull();

    m.setConcurrency(queue, 2);
    await push(m, queue, 2);
    await push(m, queue, 3);

    const pulled = await m.pullBatch(queue, 2);
    expect(pulled).toHaveLength(1);
    expect(m.getQueueJobCounts(queue).active).toBe(2);
  });

  test('a job active before the limit does not free a phantom slot when it completes', async () => {
    const m = start();
    const queue = 'limit-phantom-release';
    await push(m, queue, 1);
    const early = await m.pull(queue);
    expect(early).not.toBeNull();

    m.setConcurrency(queue, 1);
    await push(m, queue, 2);
    expect(await m.pull(queue)).toBeNull();

    await m.ack(early!.id, 'done');
    const second = await m.pull(queue);
    expect(second).not.toBeNull();

    await push(m, queue, 3);
    expect(await m.pull(queue)).toBeNull();
    expect(m.getQueueJobCounts(queue).active).toBe(1);
  });

  test('clearing and setting the limit again keeps counting the running jobs', async () => {
    const m = start();
    const queue = 'limit-clear-set';
    m.setConcurrency(queue, 1);
    await push(m, queue, 1);
    expect(await m.pull(queue)).not.toBeNull();

    m.clearConcurrency(queue);
    m.setConcurrency(queue, 1);
    await push(m, queue, 2);

    expect(await m.pull(queue)).toBeNull();
    expect(m.getQueueJobCounts(queue).active).toBe(1);
  });
});
