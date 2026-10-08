/**
 * REPRO — an embedded `Queue.close()` must not spend the WriteBuffer's retry budget.
 *
 * Run: bun test test/repro-embedded-close-respects-writebuffer-backoff.test.ts
 *
 * After a transient insert failure the WriteBuffer arms a backoff retry (200 ms,
 * doubling up to 30 s, at most ten attempts) and only then hands the rows to the
 * critical-loss path. A close() flush that ignored that backoff made one insert
 * attempt per call, so nine closes (one Queue opened and closed per request) used up
 * the whole ~80 s retry window in milliseconds and dropped every buffered row of
 * the process to the DLQ. close() now writes nothing while a backoff is armed: the
 * rows stay pending and the scheduled retry persists them once storage recovers.
 */

import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, shutdownManager } from '../src/client';
import { peekSharedManager } from '../src/client/manager';
import type { Job } from '../src/domain/types/job';

interface StorageInternals {
  writeBuffer: {
    timer: ReturnType<typeof setInterval> | null;
    backoffTimer: ReturnType<typeof setTimeout> | null;
    readonly pendingCount: number;
    flush(): number;
    getRetryState(): { retryCount: number };
  };
  batchManager: {
    insertJobsBatch(jobs: Job[]): { transient: Job[]; conflicts: Job[]; error?: Error };
  };
  getCriticalLosses(): readonly unknown[];
}

let dir = '';

afterEach(() => {
  shutdownManager();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

test('close() during a WriteBuffer backoff keeps the retry budget and the rows', async () => {
  dir = mkdtempSync(join(tmpdir(), 'bq-close-backoff-'));
  const dataPath = join(dir, 'q.db');
  const queue = new Queue('tasks', { embedded: true, dataPath });
  const storage = (peekSharedManager() as unknown as { storage: StorageInternals }).storage;
  const buffer = storage.writeBuffer;
  // Only the injected failure and the backoff retry may write: no 10 ms interval flush.
  if (buffer.timer) clearInterval(buffer.timer);
  buffer.timer = null;

  const original = storage.batchManager.insertJobsBatch;
  let attempts = 0;
  storage.batchManager.insertJobsBatch = (jobs) => {
    attempts++;
    return { transient: jobs, conflicts: [], error: new Error('SQLITE_BUSY (simulated)') };
  };

  await queue.add('job', { i: 1 });
  buffer.flush(); // the first failed attempt, as the interval flush would make it
  expect(attempts).toBe(1);
  expect(buffer.getRetryState().retryCount).toBe(1);
  expect(buffer.backoffTimer).not.toBeNull();

  for (let i = 0; i < 20; i++) new Queue('tasks', { embedded: true }).close();
  queue.close();

  expect({
    attempts,
    retryCount: buffer.getRetryState().retryCount,
    backoffArmed: buffer.backoffTimer !== null,
    pending: buffer.pendingCount,
    criticalLosses: storage.getCriticalLosses().length,
  }).toEqual({ attempts: 1, retryCount: 1, backoffArmed: true, pending: 1, criticalLosses: 0 });

  // Storage recovers: the scheduled backoff retry, not close(), writes the row.
  storage.batchManager.insertJobsBatch = original;
  const deadline = Date.now() + 5_000;
  while (buffer.pendingCount > 0 && Date.now() < deadline) await Bun.sleep(10);

  expect(buffer.pendingCount).toBe(0);
  expect(buffer.getRetryState().retryCount).toBe(0);
  expect(storage.getCriticalLosses().length).toBe(0);
  const db = new Database(dataPath, { readonly: true });
  try {
    const row = db.query("SELECT COUNT(*) AS c FROM jobs WHERE queue = 'tasks'").get() as {
      c: number;
    };
    expect(row.c).toBe(1);
  } finally {
    db.close();
  }
});
