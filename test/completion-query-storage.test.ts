/** Completion state, rather than result-cache presence, owns result lookup. */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import type { EventsManager } from '../src/application/eventsManager';
import type { RemovedResults } from '../src/application/removedResults';
import { jobId, type JobId } from '../src/domain/types/job';
import type { JobLocation } from '../src/domain/types/queue';
import type { SqliteStorage } from '../src/infrastructure/persistence/sqlite';
import type { LRUMap } from '../src/shared/lru';

let manager: QueueManager | undefined;
let directory: string | undefined;

afterEach(() => {
  manager?.shutdown();
  manager = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function persistentManager(maxCompletedJobs = 1): { manager: QueueManager; path: string } {
  directory = mkdtempSync(join(tmpdir(), 'bunqueue-completion-query-'));
  const path = join(directory, 'queue.db');
  manager = new QueueManager({ dataPath: path, maxCompletedJobs, maxJobResults: 1 });
  return { manager, path };
}

async function complete(qm: QueueManager, queue: string, result: unknown): Promise<JobId> {
  const job = await qm.push(queue, { data: {}, durable: true });
  expect((await qm.pull(queue))?.id).toBe(job.id);
  await qm.ack(job.id, result);
  return job.id;
}

describe('persistent completion lookup', () => {
  test('shutdown releases an existing wait without reading its closed SQLite database', async () => {
    const { manager: qm } = persistentManager();
    const job = await qm.push('completion-shutdown', { data: {}, durable: true });
    const waiting = qm.waitForJobResult(job.id, 5_000);
    qm.shutdown();
    manager = undefined;

    expect(await waiting).toEqual({ completed: true, result: undefined });
  });

  test('a cleared waiter reads SQLite while its completed cache entry remains', async () => {
    const { manager: qm } = persistentManager(2);
    const id = await complete(qm, 'completion-clear-cached', { kept: true });
    await complete(qm, 'completion-clear-cached', { latest: true });
    const waiting = qm.waitForJobResult(id, 5_000);

    (qm as unknown as { eventsManager: EventsManager }).eventsManager.clear();

    expect(await waiting).toEqual({ completed: true, result: { kept: true } });
  });

  test('a cleared waiter preserves its undefined fallback after completed cache eviction', async () => {
    const { manager: qm } = persistentManager();
    const id = await complete(qm, 'completion-clear-cold', { cold: true });
    await complete(qm, 'completion-clear-cold', { latest: true });
    const waiting = qm.waitForJobResult(id, 5_000);

    (qm as unknown as { eventsManager: EventsManager }).eventsManager.clear();

    expect(await waiting).toEqual({ completed: true, result: undefined });
    expect(await qm.getCompletionAsync(id)).toEqual({ found: true, result: { cold: true } });
    expect(await qm.getResultAsync(id)).toEqual({ cold: true });
  });

  test('cold completions preserve undefined and falsy results without growing caches', async () => {
    const { manager: qm, path } = persistentManager();
    const results = [undefined, null, false, 0, '', { answer: 42 }];
    const ids: JobId[] = [];
    for (const result of results) ids.push(await complete(qm, 'completion-values', result));
    qm.flushPersistence();

    for (let pass = 0; pass < 2; pass++) {
      const live = manager!;
      for (const [index, id] of ids.entries()) {
        expect(await live.getJobState(id)).toBe('completed');
        expect(await live.getCompletionAsync(id)).toEqual({ found: true, result: results[index] });
        expect(await live.getResultAsync(id)).toEqual(results[index]);
      }
      expect(live.getMemoryStats().completedJobs).toBeLessThanOrEqual(1);
      expect(live.getMemoryStats().jobResults).toBeLessThanOrEqual(1);
      if (pass === 0) {
        expect(live.getStats().totalCompleted).toBe(6n);
        live.shutdown();
        manager = new QueueManager({ dataPath: path, maxCompletedJobs: 1, maxJobResults: 1 });
      }
    }
  });

  test('an orphan persisted result does not prove completion', async () => {
    const { manager: qm } = persistentManager();
    const id = jobId('completion-orphan');
    const { storage } = qm as unknown as { storage: SqliteStorage };
    storage.storeResult(id, { stale: true });

    expect(qm.getResult(id)).toEqual({ stale: true });
    expect(await qm.getCompletionAsync(id)).toEqual({ found: false, result: undefined });
    expect(await qm.getResultAsync(id)).toBeUndefined();
    expect(await qm.getJobState(id)).toBe('unknown');
  });

  test('current waiting, active and failed generations suppress stale cached results', async () => {
    const { manager: qm } = persistentManager();
    const job = await qm.push('completion-generation', {
      data: {},
      durable: true,
      customId: 'current',
      maxAttempts: 1,
    });
    const internals = qm as unknown as {
      jobResults: LRUMap<JobId, unknown>;
      jobIndex: Map<JobId, JobLocation>;
      removedResults: RemovedResults;
    };
    internals.jobResults.set(job.id, { stale: true });
    internals.removedResults.record(job.id, job.queue, { stale: true });

    for (const state of ['waiting', 'active', 'failed']) {
      expect(await qm.getJobState(job.id)).toBe(state);
      expect(await qm.getCompletionAsync(job.id)).toEqual({ found: false, result: undefined });
      expect(await qm.getResultAsync(job.id)).toBeUndefined();
      if (state === 'waiting') await qm.pull(job.queue);
      if (state === 'active') await qm.fail(job.id, 'terminal');
    }
    // Persisted DLQ ownership must also win when the hot location is absent.
    internals.jobIndex.delete(job.id);
    expect(await qm.getJobState(job.id)).toBe('failed');
    expect(await qm.getCompletionAsync(job.id)).toEqual({ found: false, result: undefined });
    expect(await qm.getResultAsync(job.id)).toBeUndefined();
  });
});

test('an in-memory result outliving its completed cache entry is not completion evidence', async () => {
  manager = new QueueManager({ maxCompletedJobs: 1, maxJobResults: 2 });
  const id = await complete(manager, 'completion-memory-only', { stale: true });
  await complete(manager, 'completion-memory-only', { latest: true });

  expect(manager.getResult(id)).toEqual({ stale: true });
  expect(await manager.getJobState(id)).toBe('unknown');
  expect(await manager.getCompletionAsync(id)).toEqual({ found: false, result: undefined });
  expect(await manager.getResultAsync(id)).toBeUndefined();
  expect(manager.getStats().totalCompleted).toBe(2n);
});
