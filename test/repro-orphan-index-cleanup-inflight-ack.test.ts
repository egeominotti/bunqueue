/**
 * Repro: cleanup's orphaned-index sweep deleted the index entry of a job whose
 * ACK was in flight, so the ACK dropped the job and leaked every slot it held.
 *
 * `ackJob` (src/application/operations/ack/completion.ts) takes the job out of
 * its processing shard under the processing lock, then waits for the queue
 * shard lock to release the job's resources. `cleanOrphanedJobIndex`
 * (src/application/cleanupTasks.ts, active above 100,000 index entries) deleted
 * any `processing` index entry whose job was missing from its processing shard,
 * which is exactly the state of a job between those two critical sections. The
 * ACK then found no `processing` location, returned without releasing the
 * queue concurrency slot, the group slot or the unique key, and the job was
 * neither completed nor anywhere else in memory.
 */
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { cleanup } from '../src/application/cleanupTasks';
import { QueueManager } from '../src/application/queueManager';
import type { BackgroundContext } from '../src/application/types';
import { jobId } from '../src/domain/types/job';
import { processingShardIndex, shardIndex } from '../src/shared/hash';

const PAD_ENTRIES = 100_001;

let manager: QueueManager | null = null;

afterEach(() => {
  setSystemTime();
  manager?.shutdown();
  manager = null;
});

function backgroundContext(m: QueueManager): BackgroundContext {
  return (
    m as unknown as { contextFactory: { getBackgroundContext(): BackgroundContext } }
  ).contextFactory.getBackgroundContext();
}

/** The orphaned-index sweep only runs on a large index. */
function padJobIndex(ctx: BackgroundContext): void {
  for (let i = 0; i < PAD_ENTRIES; i++) {
    ctx.jobIndex.set(jobId(`pad-${i}`), { type: 'completed', queueName: 'pad' });
  }
}

test('cleanup during an in-flight ACK keeps the job and frees its slots', async () => {
  manager = new QueueManager();
  const m = manager;
  const ctx = backgroundContext(m);
  const queue = 'inflight-ack';
  const group = { concurrency: 1 };
  m.setConcurrency(queue, 1);
  await m.push(queue, { data: { n: 1 }, groupId: 'g', uniqueKey: 'u-1' });
  const first = await m.pull(queue, 0, undefined, group);
  expect(first).not.toBeNull();
  padJobIndex(ctx);

  // Hold the queue shard lock so the ACK stops between its two critical sections.
  // (No job of this shard waits in a queue, so the sweep never needs this lock.)
  const guard = await ctx.shardLocks[shardIndex(queue)].acquireWrite();
  const ack = m.ack(first!.id, 'done').then(
    () => 'completed',
    (error: unknown) => String(error)
  );
  await Bun.sleep(0);
  expect(ctx.processingShards[processingShardIndex(first!.id)].has(first!.id)).toBe(false);

  await cleanup(ctx);
  guard.release();

  expect(await ack).toBe('completed');
  expect(await m.getJobState(first!.id)).toBe('completed');
  expect(m.getGroupActiveCount(queue, 'g')).toBe(0);
  // The queue slot and the group slot are free again, and so is the unique key.
  await m.push(queue, { data: { n: 2 }, groupId: 'g' });
  const second = await m.pull(queue, 0, undefined, group);
  expect(second).not.toBeNull();
  expect(String(second!.id)).not.toBe(String(first!.id));
  const reused = await m.push(queue, { data: { n: 3 }, uniqueKey: 'u-1' });
  expect(String(reused.id)).not.toBe(String(first!.id));
});

test('a true orphan index entry is still removed once a later sweep confirms it', async () => {
  manager = new QueueManager();
  const ctx = backgroundContext(manager);
  const start = Date.now();
  setSystemTime(new Date(start));
  const orphan = jobId('true-orphan');
  ctx.jobIndex.set(orphan, {
    type: 'processing',
    shardIdx: processingShardIndex(orphan),
    queueName: 'orphan-queue',
  });
  padJobIndex(ctx);

  await cleanup(ctx);
  expect(ctx.jobIndex.has(orphan)).toBe(true);

  setSystemTime(new Date(start + 10_000));
  await cleanup(ctx);
  expect(ctx.jobIndex.has(orphan)).toBe(true);

  setSystemTime(new Date(start + 61_000));
  await cleanup(ctx);
  expect(ctx.jobIndex.has(orphan)).toBe(false);
});

test('an entry that changed between sweeps is not confirmed as an orphan', async () => {
  manager = new QueueManager();
  const ctx = backgroundContext(manager);
  const start = Date.now();
  setSystemTime(new Date(start));
  const id = jobId('redelivered');
  const location = () =>
    ({ type: 'processing', shardIdx: processingShardIndex(id), queueName: 'q' }) as const;
  ctx.jobIndex.set(id, location());
  padJobIndex(ctx);

  await cleanup(ctx);
  // A new delivery indexes the job again with a new location.
  ctx.jobIndex.set(id, location());
  setSystemTime(new Date(start + 61_000));
  await cleanup(ctx);
  expect(ctx.jobIndex.has(id)).toBe(true);
});
