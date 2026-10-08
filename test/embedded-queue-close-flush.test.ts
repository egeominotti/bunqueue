import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, shutdownManager } from '../src/client';
import { getSharedManager, peekSharedManager } from '../src/client/manager';

// Guard rails around the write flush in embedded Queue.close(). The end-to-end
// contract (rows survive an immediate process.exit()) is pinned by
// test/repro-embedded-close-exit-loses-buffered-jobs.test.ts, and the retry backoff
// by test/repro-embedded-close-respects-writebuffer-backoff.test.ts.

let dir = '';

afterEach(() => {
  shutdownManager();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function freshDataPath(): string {
  dir = mkdtempSync(join(tmpdir(), 'bq-close-flush-'));
  return join(dir, 'q.db');
}

describe('embedded Queue.close() write flush', () => {
  test('writes buffered rows before returning and keeps the manager running', async () => {
    const dataPath = freshDataPath();
    const queue = new Queue('tasks', { embedded: true, dataPath });
    await queue.add('job', { i: 1 });
    const manager = peekSharedManager();
    if (!manager) throw new Error('expected an embedded manager');
    const flush = spyOn(manager, 'flushPendingWrites');
    const snapshotFlush = spyOn(manager, 'flushPersistence');

    queue.close();

    expect(flush).toHaveBeenCalledTimes(1);
    expect(snapshotFlush).not.toHaveBeenCalled();
    expect(peekSharedManager()).toBe(manager);
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

  test('does not throw when the buffer flush throws', () => {
    const queue = new Queue('tasks', { embedded: true, dataPath: freshDataPath() });
    const buffer = (
      peekSharedManager() as unknown as { storage: { writeBuffer: { flushIfReady(): number } } }
    ).storage.writeBuffer;
    const flush = spyOn(buffer, 'flushIfReady').mockImplementation(() => {
      throw new Error('storage callback failed');
    });

    expect(() => queue.close()).not.toThrow();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  test('does not recreate a manager after shutdownManager()', async () => {
    const queue = new Queue('tasks', { embedded: true, dataPath: freshDataPath() });
    shutdownManager();

    expect(() => queue.close()).not.toThrow();
    await queue.disconnect();
    expect(peekSharedManager()).toBeNull();
  });

  test('a TCP Queue leaves the embedded manager alone', async () => {
    const flush = spyOn(getSharedManager(freshDataPath()), 'flushPendingWrites');
    const queue = new Queue('tasks', {
      embedded: false,
      connection: { host: '127.0.0.1', port: 1, poolSize: 1, pingInterval: 0 },
      autoBatch: { enabled: false },
    });

    await queue.disconnect();
    queue.close();

    expect(flush).not.toHaveBeenCalled();
  });
});
