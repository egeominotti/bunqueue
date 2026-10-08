/**
 * Pins 2.9.11 completion and telemetry write behavior under lock contention
 * from another process and in loops that never yield to the event loop, as a
 * guard for future write-path optimizations. Expected values are the output
 * of c43442c9 (2.9.11 + docs).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'bunqueue-write-contention-'));
  directories.push(directory);
  return directory;
}

const LOCKER = `import { Database } from 'bun:sqlite';
const [path, holdMs] = process.argv.slice(2);
const db = new Database(path);
db.exec('BEGIN IMMEDIATE');
console.log('LOCKED');
const end = Date.now() + Number(holdMs);
while (Date.now() < end) {}
db.exec('COMMIT');
db.close();
`;

/** Another process holds the write lock for 1,500 ms; bunqueue waits at most 400 ms. */
async function ackWhileLocked(mode: 'scalar' | 'batch') {
  const directory = tempDir();
  const path = join(directory, 'queue.db');
  const lockerPath = join(directory, 'locker.ts');
  writeFileSync(lockerPath, LOCKER);
  const manager = new QueueManager({ dataPath: path });
  const internals = manager as unknown as {
    storage: {
      db: Database;
      getJobStateRaw(id: unknown): string | null;
      getResult(id: unknown): unknown;
    };
    jobIndex: Map<unknown, { type: string }>;
  };
  try {
    const count = mode === 'batch' ? 6 : 1;
    for (let index = 0; index < count; index++) {
      await manager.push('q', { data: { index }, durable: true });
    }
    const jobs =
      mode === 'batch' ? await manager.pullBatch('q', count) : [(await manager.pull('q'))!];
    internals.storage.db.exec('PRAGMA busy_timeout = 400');
    const locker = Bun.spawn([process.execPath, lockerPath, path, '1500'], { stdout: 'pipe' });
    await locker.stdout.getReader().read();
    const started = Date.now();
    let threw = false;
    try {
      if (mode === 'batch') {
        await manager.ackBatchWithResults(jobs.map((job) => ({ id: job.id, result: { r: 1 } })));
      } else {
        await manager.ack(jobs[0].id, { r: 1 });
      }
    } catch {
      threw = true;
    }
    const blockedMs = Date.now() - started;
    await locker.exited;
    return {
      threw,
      // One 400 ms busy wait, not two (a retried write would wait 800 ms or more).
      singleWait: blockedMs < 780,
      persisted: jobs.map((job) => internals.storage.getJobStateRaw(job.id)),
      results: jobs.map((job) => internals.storage.getResult(job.id)),
      jobIndex: jobs.map((job) => internals.jobIndex.get(job.id)?.type),
    };
  } finally {
    manager.shutdown();
  }
}

describe('completion writes under lock contention keep 2.9.11 outcomes', () => {
  test('a busy result write fails once and leaves the job active (scalar)', async () => {
    expect(await ackWhileLocked('scalar')).toEqual({
      threw: true,
      singleWait: true,
      persisted: ['active'],
      results: [null],
      jobIndex: ['processing'],
    });
  }, 15_000);

  test('a busy result write fails once and leaves the jobs active (batch)', async () => {
    expect(await ackWhileLocked('batch')).toEqual({
      threw: true,
      singleWait: true,
      persisted: Array(6).fill('active'),
      results: Array(6).fill(null),
      jobIndex: Array(6).fill('processing'),
    });
  }, 15_000);
});

describe('telemetry reaches disk without event-loop turns', () => {
  test('a sequential await loop leaves every completion metric on disk', async () => {
    const path = join(tempDir(), 'queue.db');
    const manager = new QueueManager({ dataPath: path });
    const jobs = 3_000;
    try {
      for (let index = 0; index < jobs; index++) {
        await manager.push('loop', { data: { index }, durable: true });
        const job = await manager.pull('loop');
        if (job) await manager.ack(job.id, { index });
      }
      // No macrotask has run: 2.9.11 has already written every event.
      const reader = new Database(path, { readonly: true });
      try {
        const row = reader
          .query<{ total: number }, []>(
            "SELECT total_count AS total FROM queue_metrics_meta WHERE queue = 'loop' AND type = 'completed'"
          )
          .get();
        expect(row?.total).toBe(jobs);
      } finally {
        reader.close();
      }
    } finally {
      manager.shutdown();
    }
  }, 60_000);
});
