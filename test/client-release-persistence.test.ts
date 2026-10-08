/**
 * A job released by a disconnecting client goes back to its queue without a charged
 * attempt. SQLite must record the same transition: before the fix the row stayed
 * `active`, so startup recovery charged an attempt and stall the live broker never
 * charged (a job with attempts: 1 landed in the DLQ).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import type { JobId } from '../src/domain/types/job';

const QUEUE = 'release-persistence';
const CLIENT = 'client-1';

let dir = '';
let manager: QueueManager | null = null;

afterEach(() => {
  manager?.shutdown();
  manager = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function open(): QueueManager {
  dir ||= mkdtempSync(join(tmpdir(), 'bq-release-persistence-'));
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
      .query<
        { state: string; started_at: number | null; attempts: number; stall_count: number },
        [string]
      >('SELECT state, started_at, attempts, stall_count FROM jobs WHERE id = ?')
      .get(String(id));
  } finally {
    db.close();
  }
}

async function pullAndRelease(qm: QueueManager, id: JobId): Promise<void> {
  const { job } = await qm.pullWithLock(QUEUE, 'worker', 0, 60_000);
  expect(job?.id).toBe(id);
  qm.registerClientJob(CLIENT, id);
  expect(await qm.releaseClientJobs(CLIENT)).toBe(1);
  expect(await qm.getJobState(id)).not.toBe('active');
}

describe('client disconnect release persistence', () => {
  test('a released job is stored waiting and survives a restart uncharged', async () => {
    const qm = open();
    const pushed = await qm.push(QUEUE, { data: { n: 1 }, maxAttempts: 1, durable: true });
    await pullAndRelease(qm, pushed.id);

    expect(row(pushed.id)).toEqual({
      state: 'waiting',
      started_at: null,
      attempts: 0,
      stall_count: 0,
    });

    const next = restart();
    expect(await next.getJobState(pushed.id)).toBe('waiting');
    expect((await next.getJob(pushed.id))?.attempts).toBe(0);
    expect(next.getDlq(QUEUE)).toHaveLength(0);
    expect((await next.pull(QUEUE))?.id).toBe(pushed.id);
  });

  test('a released prioritized job keeps its prioritized state on disk', async () => {
    const qm = open();
    const pushed = await qm.push(QUEUE, { data: {}, priority: 5, durable: true });
    await pullAndRelease(qm, pushed.id);

    expect(row(pushed.id)?.state).toBe('prioritized');
    expect(await restart().getJobState(pushed.id)).toBe('prioritized');
  });

  test('a job still in the write buffer is inserted with its released state', async () => {
    const qm = open();
    // Hold the buffer: no flush may run until the release has happened, so the
    // insert carries whatever state the buffered job has by then.
    const storage = (qm as unknown as { storage: object }).storage;
    const buffer = (storage as { writeBuffer: Record<string, () => unknown> }).writeBuffer;
    const flushIfReady = buffer.flushIfReady;
    const flushBestEffort = buffer.flushBestEffort;
    buffer.flushIfReady = () => 0;
    buffer.flushBestEffort = () => undefined;

    const pushed = await qm.push(QUEUE, { data: {}, maxAttempts: 1 });
    await pullAndRelease(qm, pushed.id);
    expect(row(pushed.id)).toBeNull();

    buffer.flushIfReady = flushIfReady;
    buffer.flushBestEffort = flushBestEffort;
    const next = restart();
    expect(await next.getJobState(pushed.id)).toBe('waiting');
    expect((await next.getJob(pushed.id))?.attempts).toBe(0);
    expect(next.getDlq(QUEUE)).toHaveLength(0);
  });

  test('a renewed delivery is not released and stays active on disk', async () => {
    const qm = open();
    const pushed = await qm.push(QUEUE, { data: {}, durable: true });
    const { job, token } = await qm.pullWithLock(QUEUE, 'worker', 0, 60_000);
    expect(job?.id).toBe(pushed.id);
    expect(await qm.extendLock(pushed.id, token, 60_000)).toBe(true);
    qm.registerClientJob(CLIENT, pushed.id);

    expect(await qm.releaseClientJobs(CLIENT)).toBe(0);
    expect(await qm.getJobState(pushed.id)).toBe('active');
    expect(row(pushed.id)?.state).toBe('active');
  });
});
