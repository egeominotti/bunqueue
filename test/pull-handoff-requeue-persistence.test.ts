/**
 * A pull handoff that fails after the job was stored `active` must store it queued
 * again. `finalizeProcessing` persists the `active` state first and then publishes the
 * `pulled` event; when that publication throws, `requeueJob` returns the job to its
 * queue. Without persisting that return the row stayed `active`, so startup recovery
 * charged an attempt for a job no worker ever received (a job with attempts: 1 went to
 * the DLQ). The requeue also drops the `active` timeline entry the dequeue appended.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import type { JobId } from '../src/domain/types/job';

const QUEUE = 'handoff-requeue';

let dir = '';
let manager: QueueManager | null = null;

afterEach(() => {
  manager?.shutdown();
  manager = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function open(): QueueManager {
  dir = mkdtempSync(join(tmpdir(), 'bq-handoff-requeue-'));
  manager = new QueueManager({ dataPath: join(dir, 'bunq.db') });
  return manager;
}

function restart(): QueueManager {
  manager?.shutdown();
  manager = new QueueManager({ dataPath: join(dir, 'bunq.db') });
  return manager;
}

function row(id: JobId) {
  const db = new Database(join(dir, 'bunq.db'), { readonly: true });
  try {
    return db
      .query<{ state: string; started_at: number | null; attempts: number }, [string]>(
        'SELECT state, started_at, attempts FROM jobs WHERE id = ?'
      )
      .get(String(id));
  } finally {
    db.close();
  }
}

/** Make the next `pulled` publication throw, after the handoff stored the job active. */
function failNextPublication(qm: QueueManager, method: 'broadcast' | 'broadcastBatch') {
  const events = (qm as unknown as { eventsManager: Record<string, unknown> }).eventsManager;
  const original = events[method];
  let storedActive: string | undefined;
  events[method] = (...args: unknown[]) => {
    events[method] = original;
    const pulled = (args[0] as Array<{ jobId: JobId }> | { jobId: JobId }) ?? {};
    const first = Array.isArray(pulled) ? pulled[0] : pulled;
    storedActive = row(first.jobId)?.state;
    throw new Error('publication failed');
  };
  return () => storedActive;
}

async function expectQueuedAndUncharged(id: JobId) {
  expect(row(id)).toEqual({ state: 'waiting', started_at: null, attempts: 0 });
  const next = restart();
  expect(await next.getJobState(id)).toBe('waiting');
  const job = await next.getJob(id);
  expect(job?.attempts).toBe(0);
  expect(job?.timeline.at(-1)?.state).not.toBe('active');
  expect(next.getDlq(QUEUE)).toHaveLength(0);
  expect((await next.pull(QUEUE))?.id).toBe(id);
}

describe('pull handoff failure after the job was stored active', () => {
  test('PULL: the job is stored queued again and a restart does not charge it', async () => {
    const qm = open();
    const pushed = await qm.push(QUEUE, { data: {}, maxAttempts: 1, durable: true });
    const storedActive = failNextPublication(qm, 'broadcast');

    expect(await qm.pull(QUEUE)).toBeNull();
    expect(storedActive()).toBe('active');
    expect(await qm.getJobState(pushed.id)).toBe('waiting');
    expect((await qm.getJob(pushed.id))?.timeline.at(-1)?.state).not.toBe('active');

    await expectQueuedAndUncharged(pushed.id);
  });

  test('PULLB: every job of the failed batch is stored queued again', async () => {
    const qm = open();
    const first = await qm.push(QUEUE, { data: { n: 1 }, maxAttempts: 1, durable: true });
    const second = await qm.push(QUEUE, { data: { n: 2 }, maxAttempts: 1, durable: true });
    const storedActive = failNextPublication(qm, 'broadcastBatch');

    expect(await qm.pullBatch(QUEUE, 5)).toEqual([]);
    expect(storedActive()).toBe('active');
    expect(row(second.id)?.state).toBe('waiting');

    await expectQueuedAndUncharged(first.id);
    expect((await manager!.getJob(second.id))?.attempts).toBe(0);
  });
});
