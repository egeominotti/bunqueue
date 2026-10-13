/**
 * Repro: a late ACK of a job that is already back in the queue frees a group
 * concurrency slot it does not hold.
 *
 * Found while fixing queue-level concurrency slot ownership (model seed 418721315).
 * `completeStallRetriedJob` (src/application/queue-manager/delivery.ts) completes a job
 * that is waiting in the queue after a retry, and released its job resources as if it
 * were active: the group's active count dropped while another job of the group still
 * ran, so a group with concurrency 1 admitted a second active job.
 */
import { afterEach, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';

let manager: QueueManager | null = null;

afterEach(() => {
  manager?.shutdown();
  manager = null;
});

test('a late ACK of a retried waiting job keeps the group limit', async () => {
  manager = new QueueManager();
  const m = manager;
  const queue = 'group-late-ack';
  await m.setGroupConcurrency(queue, 'g', 1);
  // A stored group override applies only when the Worker supplies the matching group
  // default (BullMQ Pro local-override contract), so every pull carries it.
  const group = { concurrency: 1 };
  await m.push(queue, { data: { n: 1 }, groupId: 'g', maxAttempts: 5, backoff: 60_000 });
  await m.push(queue, { data: { n: 2 }, groupId: 'g' });

  const first = await m.pull(queue, 0, undefined, group);
  expect(first).not.toBeNull();
  await m.fail(first!.id, 'transient');

  const second = await m.pull(queue, 0, undefined, group);
  expect(second).not.toBeNull();
  expect(String(second!.id)).not.toBe(String(first!.id));
  expect(m.getGroupActiveCount(queue, 'g')).toBe(1);

  // The first attempt's worker reports success after its retry was scheduled.
  await m.ack(first!.id, 'late');
  expect(m.getGroupActiveCount(queue, 'g')).toBe(1);

  await m.push(queue, { data: { n: 3 }, groupId: 'g' });
  expect(await m.pull(queue, 0, undefined, group)).toBeNull();
  expect(m.getQueueJobCounts(queue).active).toBe(1);
});
