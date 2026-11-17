import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import type { Job } from '../src/domain/types/job';

let manager: QueueManager | undefined;
let directory: string | undefined;

afterEach(() => {
  manager?.shutdown();
  manager = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function openManager(backend: string, maxCompletedJobs?: number): QueueManager {
  let dataPath: string | undefined;
  if (backend === 'SQLite') {
    directory = mkdtempSync(join(tmpdir(), 'bunqueue-dependency-audit-'));
    dataPath = join(directory, 'queue.db');
  }
  manager = new QueueManager(
    maxCompletedJobs === undefined ? { dataPath } : { dataPath, maxCompletedJobs }
  );
  return manager;
}

async function complete(manager: QueueManager, job: Job): Promise<void> {
  expect((await manager.pull(job.queue))?.id).toBe(job.id);
  await manager.ack(job.id);
  expect(await manager.getJobState(job.id)).toBe('completed');
}

describe.each(['memory', 'SQLite'])('%s dependency completion', (backend) => {
  for (const cap of [2, 8]) {
    test(`both prerequisites release an admitted consumer with a completion cache of ${cap}`, async () => {
      const manager = openManager(backend, cap);
      const first = await manager.push('first', { data: {}, durable: true });
      const second = await manager.push('second', { data: {}, durable: true });
      const consumer = await manager.push('consumer', {
        data: {},
        dependsOn: [first.id, second.id],
        durable: true,
      });
      expect(await manager.getJobState(consumer.id)).toBe('waiting-children');

      await complete(manager, first);
      for (let index = 0; index < 2; index++) {
        const unrelated = await manager.push('unrelated', { data: index, durable: true });
        await complete(manager, unrelated);
      }
      expect(await manager.pull('consumer')).toBeNull();
      await complete(manager, second);
      if (backend === 'SQLite') expect(await manager.getJobState(first.id)).toBe('completed');

      const claimed = await manager.pull('consumer', 300);
      const counts = manager.getQueueJobCounts('consumer');
      expect({
        id: claimed?.id,
        state: await manager.getJobState(consumer.id),
        active: counts.active,
        blocked: counts['waiting-children'],
      }).toEqual({ id: consumer.id, state: 'active', active: 1, blocked: 0 });
    });
  }

  test('canceling the last dependent leaves its outstanding prerequisite unresolved', async () => {
    const manager = openManager(backend);
    const prerequisite = await manager.push('source', { data: {}, durable: true });
    const addConsumer = () =>
      manager.push('consumer', { data: {}, dependsOn: [prerequisite.id], durable: true });
    const canceled = await addConsumer();
    expect(await manager.getJobState(canceled.id)).toBe('waiting-children');
    expect(await manager.cancel(canceled.id)).toBe(true);
    expect(await manager.getJobState(canceled.id)).toBe('unknown');

    const replacement = await addConsumer();
    expect(await manager.getJobState(prerequisite.id)).toBe('waiting');
    const earlyClaim = await manager.pull('consumer');
    const counts = manager.getQueueJobCounts('consumer');
    expect({
      earlyClaim: earlyClaim?.id,
      state: await manager.getJobState(replacement.id),
      active: counts.active,
      blocked: counts['waiting-children'],
    }).toEqual({ earlyClaim: undefined, state: 'waiting-children', active: 0, blocked: 1 });

    await complete(manager, prerequisite);
    expect((await manager.pull('consumer', 300))?.id).toBe(replacement.id);
  });
});
