/**
 * Pins the ACK completion and telemetry write behavior of 2.9.11 on failure
 * paths (full disk for still-buffered jobs, unserializable results, a closed
 * storage, a rolled-back obliteration, payload mutation, the backup boundary).
 * Any future write-path optimization (grouping, deferring) must keep these
 * outcomes. Each expectation is the output of c43442c9 (2.9.11 + docs).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import { EventType } from '../src/domain/types/queue';
import { SqliteStorage } from '../src/infrastructure/persistence/sqlite';
import { decodeMessagePack } from '../src/shared/msgpack';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'bunqueue-write-equivalence-'));
  directories.push(directory);
  return join(directory, 'queue.db');
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const diskFull = (): Error => new Error('SQLITE_FULL: database or disk is full');

// Internal handles used to inject storage failures.
type Internals = {
  storage: SqliteStorage & {
    batchManager: { insertJobsBatch: (jobs: unknown[]) => unknown };
    statements: Map<string, unknown>;
    writeBuffer: { flush: () => number };
    getBufferedJobState: (id: unknown) => string | null;
  };
  jobIndex: Map<unknown, { type: string }>;
};

/**
 * Jobs stay in the write buffer (inserts fail as on a full disk), then every
 * result write fails. 2.9.11 leaves them active, so a restart runs them again.
 */
async function ackBufferedWithFailingResults(mode: 'scalar' | 'batch') {
  const manager = new QueueManager({ dataPath: tempPath() });
  const internals = manager as unknown as Internals;
  const storage = internals.storage;
  const batchManager = storage.batchManager;
  const insertJobs = batchManager.insertJobsBatch.bind(batchManager);
  let failInserts = true;
  batchManager.insertJobsBatch = (jobs) => {
    if (failInserts) throw diskFull();
    return insertJobs(jobs);
  };
  try {
    const count = mode === 'batch' ? 6 : 1;
    for (let index = 0; index < count; index++) await manager.push('q', { data: { index } });
    try {
      storage.writeBuffer.flush();
    } catch {
      // The injected failure keeps the jobs buffered.
    }
    const jobs =
      mode === 'batch' ? await manager.pullBatch('q', count) : [(await manager.pull('q'))!];
    const insertResult = storage.statements.get('insertResult');
    storage.statements.set('insertResult', {
      run() {
        throw diskFull();
      },
    });
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
    const buffered = jobs.map((job) => storage.getBufferedJobState(job.id));
    storage.statements.set('insertResult', insertResult);
    failInserts = false;
    storage.flushWriteBuffer();
    return {
      threw,
      buffered,
      persisted: jobs.map((job) => storage.getJobStateRaw(job.id)),
      results: jobs.map((job) => storage.getResult(job.id)),
      jobIndex: jobs.map((job) => internals.jobIndex.get(job.id)?.type),
    };
  } finally {
    manager.shutdown();
  }
}

describe('completion writes keep 2.9.11 failure behavior', () => {
  test('a failed result write never persists a buffered job as completed (scalar)', async () => {
    expect(await ackBufferedWithFailingResults('scalar')).toEqual({
      threw: true,
      buffered: ['active'],
      persisted: ['active'],
      results: [null],
      jobIndex: ['processing'],
    });
  });

  test('a failed result write never persists buffered jobs as completed (batch)', async () => {
    expect(await ackBufferedWithFailingResults('batch')).toEqual({
      threw: true,
      buffered: Array(6).fill('active'),
      persisted: Array(6).fill('active'),
      results: Array(6).fill(null),
      jobIndex: Array(6).fill('processing'),
    });
  });

  test('an unserializable result fails before the job index moves', async () => {
    const manager = new QueueManager({ dataPath: tempPath() });
    const internals = manager as unknown as Internals;
    try {
      await manager.push('q', { data: { i: 1 } });
      const job = (await manager.pull('q'))!;
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;
      await expect(manager.ack(job.id, circular)).rejects.toThrow();
      expect(internals.jobIndex.get(job.id)?.type).toBe('processing');
      expect(internals.storage.getJobStateRaw(job.id)).toBe('active');
    } finally {
      manager.shutdown();
    }
  });

  test('an ACK after storage.close() writes and fails exactly as 2.9.11 did', async () => {
    const path = tempPath();
    const manager = new QueueManager({ dataPath: path });
    const internals = manager as unknown as Internals;
    await manager.push('q', { data: { i: 1 }, durable: true });
    const job = (await manager.pull('q'))!;
    await new Promise((resolve) => setTimeout(resolve, 20));
    internals.storage.close();
    await expect(manager.ack(job.id, { r: 1 })).rejects.toThrow('Cannot use a closed database');
    expect(internals.jobIndex.get(job.id)?.type).toBe('completed');
    const reader = new Database(path, { readonly: true });
    try {
      expect(reader.query('SELECT state FROM jobs WHERE id = ?').get(String(job.id))).toEqual({
        state: 'completed',
      });
      expect(
        reader.query('SELECT COUNT(*) AS c FROM job_results WHERE job_id = ?').get(String(job.id))
      ).toEqual({ c: 1 });
    } finally {
      reader.close();
    }
  });

  test('a completed row always has its result row when the worker returned one', async () => {
    const path = tempPath();
    const manager = new QueueManager({ dataPath: path });
    const db = (manager as unknown as { storage: { db: Database } }).storage.db;
    const guard = `WHEN NEW.state = 'completed' AND NEW.queue = 'invariant'
      AND NOT EXISTS (SELECT 1 FROM job_results WHERE job_id = NEW.id)
      BEGIN SELECT RAISE(ABORT, 'completed before its result'); END`;
    db.run(`CREATE TRIGGER result_first_update BEFORE UPDATE OF state ON jobs ${guard}`);
    db.run(`CREATE TRIGGER result_first_insert BEFORE INSERT ON jobs ${guard}`);
    try {
      for (const durable of [true, false]) {
        for (const size of [1, 3, 8]) {
          await manager.pushBatch(
            'invariant',
            Array.from({ length: size }, (_, index) => ({ data: { index }, durable }))
          );
          const jobs = await manager.pullBatch('invariant', size);
          if (size === 1) await manager.ack(jobs[0].id, { only: true });
          else
            await manager.ackBatchWithResults(
              jobs.map((job) => ({ id: job.id, result: { id: job.id } }))
            );
          manager.flushPersistence();
          for (const job of jobs) {
            expect(db.query('SELECT state FROM jobs WHERE id = ?').get(job.id)).toEqual({
              state: 'completed',
            });
          }
        }
      }
    } finally {
      manager.shutdown();
    }
  });
});

describe('telemetry writes keep 2.9.11 behavior', () => {
  const event = (queue: string, jobId: string, data?: unknown) => ({
    eventType: EventType.Completed,
    queue,
    jobId,
    timestamp: Date.now(),
    data,
  });

  test("a rolled-back queue deletion keeps other queues' events and counts", async () => {
    const storage = new SqliteStorage({ path: tempPath() });
    const db = (storage as unknown as { db: Database }).db;
    const rows = (queue: string) =>
      db
        .query<{ job_id: string }, [string]>(
          'SELECT job_id FROM queue_events WHERE queue = ? ORDER BY id'
        )
        .all(queue)
        .map((row) => row.job_id);
    db.run(`INSERT INTO queue_state (name) VALUES ('victim')`);
    db.run(`CREATE TRIGGER fail_victim BEFORE DELETE ON queue_state WHEN OLD.name = 'victim'
      BEGIN SELECT RAISE(ABORT, 'simulated failure after telemetry delete'); END`);
    try {
      storage.recordQueueEvent(event('other', 'a'), 1, 10);
      expect(() => storage.deleteJobsForQueue('victim', new Set(), 10)).toThrow();
      await nextTurn();
      expect(rows('other')).toEqual(['a']);
      storage.recordQueueEvent(event('other', 'b'), 1, 10);
      await nextTurn();
      expect(rows('other')).toEqual(['b']);
      expect(storage.getQueueMetrics('other', 'completed', 10).meta.count).toBe(2);
    } finally {
      storage.close();
    }
  });

  test('the stored payload is the value at the time of the event', async () => {
    const storage = new SqliteStorage({ path: tempPath() });
    const db = (storage as unknown as { db: Database }).db;
    const result = { status: 'done' };
    try {
      storage.recordQueueEvent(event('q', 'j1', result), 100, 10);
      await Promise.resolve();
      result.status = 'MUTATED';
      await nextTurn();
      const row = db.query<{ payload: Uint8Array }, []>('SELECT payload FROM queue_events').get();
      expect(decodeMessagePack(row!.payload)).toEqual({ data: { status: 'done' } });
    } finally {
      storage.close();
    }
  });

  test('flushPersistence (backup boundary) also writes pending telemetry', async () => {
    const path = tempPath();
    const manager = new QueueManager({ dataPath: path });
    try {
      await manager.push('backup-boundary', { data: { i: 1 }, durable: true });
      manager.flushPersistence();
      const reader = new Database(path, { readonly: true });
      try {
        const row = reader
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM queue_events WHERE queue = 'backup-boundary'"
          )
          .get();
        expect(row?.count).toBe(1);
      } finally {
        reader.close();
      }
    } finally {
      manager.shutdown();
    }
  });
});
