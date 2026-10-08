/**
 * A non-durable admission that retires a persisted generation (a recycled custom
 * jobId, or a replaced deduplication owner) must commit the retirement and the
 * successor row in one SQLite transaction. Buffering the successor after the
 * retirement committed let a crash inside the write-buffer window erase both.
 * Plain admissions and completion-pin-only admissions stay buffered.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJob, jobId, type Job } from '../src/domain/types/job';
import { SqliteStorage } from '../src/infrastructure/persistence/sqlite';

const QUEUE = 'buffered-retirement';

function makeJob(id: string, data: unknown, extra: Partial<{ uniqueKey: string }> = {}): Job {
  return createJob(jobId(id), QUEUE, { data, customId: id, ...extra });
}

function invalid(job: Job): Job {
  return { ...job, queue: null } as unknown as Job;
}

describe('SqliteStorage buffered admission with a retirement', () => {
  let directory: string;
  let storage: SqliteStorage;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'bunqueue-buffered-retirement-'));
    storage = new SqliteStorage({
      path: join(directory, 'queue.db'),
      writeBufferSize: 1_000,
      writeBufferFlushMs: 60_000,
    });
  });

  afterEach(async () => {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  });

  function persistCompleted(id: string): Job {
    const job = makeJob(id, { gen: 1 });
    storage.insertJobImmediate(job);
    storage.markCompleted(job.id, Date.now());
    storage.storeResult(job.id, { receipt: `R-${id}` });
    return job;
  }

  test('commits a completed-generation retirement with its non-durable successor', () => {
    const previous = persistCompleted('order-done');
    const successor = makeJob('order-done', { gen: 2 });

    storage.insertJob(successor, false, { retireGenerationId: previous.id });

    expect(storage.getJob(successor.id)?.data).toEqual({ gen: 2 });
    expect(storage.getResult(previous.id)).toBeNull();
    expect(storage.getBufferedJob(successor.id)).toBeNull();
    expect(storage.flushWriteBuffer()).toBe(0);
  });

  test('commits a DLQ-generation retirement with its non-durable successor', () => {
    const previous = makeJob('order-dlq', { gen: 1 });
    storage.insertJobImmediate(previous);
    storage.markFailed(previous, 'boom');
    expect(storage.hasDlqEntry(previous.id)).toBe(true);
    const successor = makeJob('order-dlq', { gen: 2 });

    storage.insertJob(successor, false, { retireGenerationId: previous.id });

    expect(storage.hasDlqEntry(previous.id)).toBe(false);
    expect(storage.getJob(successor.id)?.data).toEqual({ gen: 2 });
    expect(storage.flushWriteBuffer()).toBe(0);
  });

  test('keeps the previous generation when the non-durable successor is rejected', () => {
    const previous = persistCompleted('order-rejected');
    const successor = invalid(makeJob('order-rejected', { gen: 2 }));

    expect(() => storage.insertJob(successor, false, { retireGenerationId: previous.id })).toThrow(
      /NOT NULL constraint failed: jobs\.queue/
    );

    expect(storage.getJob(previous.id)?.data).toEqual({ gen: 1 });
    expect(storage.getResult(previous.id)).toEqual({ receipt: 'R-order-rejected' });
    expect(storage.flushWriteBuffer()).toBe(0);
  });

  test('keeps a dedup owner when its non-durable replacement is rejected', () => {
    const owner = makeJob('dedup-owner', { v: 1 }, { uniqueKey: 'dk' });
    storage.insertJobImmediate(owner);
    const replacement = invalid(makeJob('dedup-successor', { v: 2 }, { uniqueKey: 'dk' }));

    expect(() => storage.replaceJob(owner.id, replacement)).toThrow(
      /NOT NULL constraint failed: jobs\.queue/
    );

    expect(storage.getJob(owner.id)?.uniqueKey).toBe('dk');
    expect(storage.getJob(replacement.id)).toBeNull();
    expect(storage.flushWriteBuffer()).toBe(0);
  });

  test('keeps plain and completion-pin-only admissions buffered', () => {
    const dependency = jobId('removed-dependency');
    storage.commitRemovedCompletion({ id: dependency, queue: QUEUE }, 100, false);
    const plain = makeJob('plain', { v: 1 });
    const consumer = createJob(jobId('consumer'), QUEUE, {
      data: {},
      dependsOn: [dependency],
    });

    storage.insertJob(plain);
    storage.insertJob(consumer, false, { completionPins: [dependency] });

    expect(storage.getJob(plain.id)).toBeNull();
    expect(storage.getJob(consumer.id)).toBeNull();
    expect(storage.getBufferedJob(plain.id)?.id).toBe(plain.id);
    expect(storage.getBufferedJob(consumer.id)?.id).toBe(consumer.id);
    const pin = storage.loadDependencyCompletions().find((record) => record.jobId === dependency);
    expect(pin?.pinned).toBe(true);
    expect(storage.flushWriteBuffer()).toBe(2);
    expect(storage.getJob(consumer.id)?.id).toBe(consumer.id);
  });
});
