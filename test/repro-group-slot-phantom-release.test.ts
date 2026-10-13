/**
 * Repro: the group active count was a plain counter, so any release that did
 * not match an acquire (a duplicate release, or the release of a job that does
 * not hold a slot of the group) freed a slot another active job still held.
 *
 * Every exit from `active` releases through `Shard.releaseJobResources(queue,
 * uniqueKey, groupId, jobId)`. Its queue concurrency slot is already owned by
 * job id (a duplicate release is a no-op); its group slot was not. The racy
 * windows that can release twice (a failed handoff's `requeueJob` overlapping a
 * batch ACK or a management claim, or an obliterate overlapping a batch ACK)
 * reduce to the two calls below, which this test makes deterministic.
 */
import { afterEach, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import type { Shard } from '../src/domain/queue/shard';
import { jobId } from '../src/domain/types/job';
import { shardIndex } from '../src/shared/hash';

let manager: QueueManager | null = null;

afterEach(() => {
  manager?.shutdown();
  manager = null;
});

function shardOf(m: QueueManager, queue: string): Shard {
  return (m as unknown as { shards: Shard[] }).shards[shardIndex(queue)];
}

test('a duplicate group release frees only the slot its job held', async () => {
  manager = new QueueManager();
  const m = manager;
  const queue = 'group-duplicate-release';
  const group = { concurrency: 2 };
  for (let n = 1; n <= 3; n++) await m.push(queue, { data: { n }, groupId: 'g' });

  const first = await m.pull(queue, 0, undefined, group);
  const second = await m.pull(queue, 0, undefined, group);
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(m.getGroupActiveCount(queue, 'g')).toBe(2);

  const shard = shardOf(m, queue);
  shard.releaseJobResources(queue, null, 'g', first!.id);
  expect(m.getGroupActiveCount(queue, 'g')).toBe(1);
  // The same job released again (two exit paths racing for one delivery).
  shard.releaseJobResources(queue, null, 'g', first!.id);
  expect(m.getGroupActiveCount(queue, 'g')).toBe(1);

  // Only one slot is free: the third job is admitted, and nothing beyond it.
  expect(await m.pull(queue, 0, undefined, group)).not.toBeNull();
  expect(m.getGroupActiveCount(queue, 'g')).toBe(2);
  await m.push(queue, { data: { n: 4 }, groupId: 'g' });
  expect(await m.pull(queue, 0, undefined, group)).toBeNull();
});

test('releasing a job that holds no slot of the group changes nothing', async () => {
  manager = new QueueManager();
  const m = manager;
  const queue = 'group-non-holder-release';
  const group = { concurrency: 1 };
  await m.push(queue, { data: { n: 1 }, groupId: 'g' });
  await m.push(queue, { data: { n: 2 }, groupId: 'g' });
  await m.push(queue, { data: { n: 3 }, groupId: 'other' });

  const active = await m.pull(queue, 0, undefined, group);
  expect(active).not.toBeNull();
  const other = await m.pull(queue, 0, undefined, group);
  expect(other?.groupId).toBe('other');
  expect(m.getGroupActiveCount(queue, 'g')).toBe(1);

  const shard = shardOf(m, queue);
  // A job that never became active, and an active job of another group.
  shard.releaseJobResources(queue, null, 'g', jobId('never-active'));
  shard.releaseJobResources(queue, null, 'g', other!.id);
  expect(m.getGroupActiveCount(queue, 'g')).toBe(1);
  expect(m.getGroupActiveCount(queue, 'other')).toBe(1);
  expect(await m.pull(queue, 0, undefined, group)).toBeNull();
});
