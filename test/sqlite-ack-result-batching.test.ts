/**
 * A result-bearing batch ACK runs the scalar storeResult()/markCompleted() statements
 * (same statements, arguments and order) inside one SQLite transaction. Failure
 * equivalence with 2.9.11 is pinned by repro-write-path-faults / -contention / -equivalence;
 * these tests pin the transaction itself and its scalar fallbacks.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import { createJob, jobId } from '../src/domain/types/job';
import { SqliteStorage } from '../src/infrastructure/persistence/sqlite';

type Statement = { run: (...args: unknown[]) => unknown };
type Internals = {
  db: Database;
  statements: Map<string, Statement>;
};

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'bunqueue-ack-result-batch-test-'));
  directories.push(directory);
  return join(directory, 'queue.db');
}

/** Record, for every call of the named statements, whether a transaction was open. */
function recordTransactions(storage: SqliteStorage, names: string[]): Record<string, boolean[]> {
  const internals = storage as unknown as Internals;
  const seen: Record<string, boolean[]> = {};
  for (const name of names) {
    const real = internals.statements.get(name)!;
    seen[name] = [];
    internals.statements.set(name, {
      run(...args: unknown[]) {
        seen[name].push(internals.db.inTransaction);
        return real.run(...args);
      },
    });
  }
  return seen;
}

function resultCount(storage: SqliteStorage): number {
  return (storage as unknown as Internals).db
    .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM job_results')
    .get()!.n;
}

type ManagerInternals = {
  storage: SqliteStorage & {
    commitCompletionWrites: SqliteStorage['commitCompletionWrites'];
  };
  jobIndex: Map<unknown, { type: string }>;
  completedJobs: { has(id: unknown): boolean };
  jobResults: { has(id: unknown): boolean };
  metrics: { totalCompleted: { value: bigint } };
};

/**
 * Run one 6-job result-bearing batch ACK and snapshot every observable outcome. With
 * `scalar`, commitCompletionWrites is disabled, which is exactly the 2.9.11 loop.
 */
async function ackScenario(
  scalar: boolean,
  prepare: (internals: ManagerInternals, db: Database) => void
): Promise<unknown> {
  const path = tempPath();
  const manager = new QueueManager({ dataPath: path });
  const internals = manager as unknown as ManagerInternals;
  const lines: string[] = [];
  const saved = [console.error, console.log, console.info, console.warn] as const;
  try {
    // Fixed IDs: a batch ACK extracts jobs in processing-shard order, so both runs
    // must route the same IDs to the same shards to process them in the same order.
    const ids = await manager.pushBatch(
      'scenario',
      Array.from({ length: 6 }, (_, index) => ({
        data: { index },
        durable: true,
        customId: `scenario-job-${index}`,
      }))
    );
    const jobs = await manager.pullBatch('scenario', ids.length);
    jobs.sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
    if (scalar) internals.storage.commitCompletionWrites = () => undefined;
    prepare(internals, (internals.storage as unknown as Internals).db);
    const capture = (...args: unknown[]) => lines.push(args.map(String).join(' ').slice(0, 40));
    console.error = capture;
    console.log = capture;
    console.info = capture;
    console.warn = capture;
    let threw: string | null = null;
    try {
      await manager.ackBatchWithResults(
        jobs.map((job, index) => ({ id: job.id, result: { index, pad: 'x'.repeat(3000) } }))
      );
    } catch (error) {
      threw = (error as Error).message.slice(0, 40);
    }
    [console.error, console.log, console.info, console.warn] = saved;
    const reader = new Database(path, { readonly: true });
    try {
      return {
        threw,
        totalCompleted: internals.metrics.totalCompleted.value,
        disk: jobs.map(
          (job) =>
            (
              reader.query('SELECT state FROM jobs WHERE id = ?').get(String(job.id)) as {
                state: string;
              } | null
            )?.state ?? '-'
        ),
        results: jobs.map(
          (job) =>
            (
              reader
                .query('SELECT COUNT(*) AS c FROM job_results WHERE job_id = ?')
                .get(String(job.id)) as { c: number }
            ).c
        ),
        idx: jobs.map((job) => internals.jobIndex.get(job.id)?.type ?? '-'),
        done: jobs.map((job) => internals.completedJobs.has(job.id)),
        mres: jobs.map((job) => internals.jobResults.has(job.id)),
        diskFull: internals.storage.getDiskFullStatus().diskFull,
        lines,
      };
    } finally {
      reader.close();
    }
  } finally {
    [console.error, console.log, console.info, console.warn] = saved;
    try {
      manager.shutdown();
    } catch {
      // A scenario may have closed the storage already.
    }
  }
}

describe('result-bearing batch ACK matches the scalar loop under real failures', () => {
  const scenarios: Array<[string, (internals: ManagerInternals, db: Database) => void]> = [
    ['storage closed before the ACK', (internals) => internals.storage.close()],
    [
      'a real SQLITE_FULL from max_page_count',
      (_internals, db) => {
        const pages = (db.query('PRAGMA page_count').get() as { page_count: number }).page_count;
        db.run(`PRAGMA max_page_count = ${pages}`);
      },
    ],
  ];
  for (const [name, prepare] of scenarios) {
    test(name, async () => {
      const scalar = await ackScenario(true, prepare);
      const batched = await ackScenario(false, prepare);
      expect(batched).toEqual(scalar);
    });
  }
});

describe('result-bearing batch ACK persistence', () => {
  test('writes every result and completion inside one transaction', async () => {
    const manager = new QueueManager({ dataPath: tempPath() });
    const storage = (manager as unknown as { storage: SqliteStorage }).storage;
    try {
      const ids = await manager.pushBatch(
        'result-batch',
        Array.from({ length: 8 }, (_, index) => ({ data: { index }, durable: true }))
      );
      const pulled = await manager.pullBatch('result-batch', ids.length);
      expect(pulled).toHaveLength(8);
      const seen = recordTransactions(storage, ['insertResult', 'completeJob']);
      await manager.ackBatchWithResults(
        pulled.map((job, index) => ({ id: job.id, result: index === 3 ? undefined : { index } }))
      );

      expect(seen.insertResult).toEqual(Array(7).fill(true));
      expect(seen.completeJob).toEqual(Array(8).fill(true));
      expect((storage as unknown as Internals).db.inTransaction).toBe(false);
      for (const job of pulled) {
        expect(storage.getJobStateRaw(job.id)).toBe('completed');
        const index = (job.data as { index: number }).index;
        expect(storage.hasResult(job.id)).toBe(index !== 3);
      }
    } finally {
      manager.shutdown();
    }
  });

  test('commits exactly the writes before the first failure, like autocommits', () => {
    const storage = new SqliteStorage({ path: tempPath() });
    const internals = storage as unknown as Internals;
    const ids = [jobId('prefix-0'), jobId('prefix-1')];
    try {
      for (const id of ids) storage.insertJobImmediate(createJob(id, 'q', { data: {} }));
      for (const id of ids) storage.markActive(id, Date.now(), []);
      const real = internals.statements.get('insertResult')!;
      let calls = 0;
      internals.statements.set('insertResult', {
        run(...args: unknown[]) {
          if (++calls === 2) throw new Error('injected');
          return real.run(...args);
        },
      });
      const outcome = storage.commitCompletionWrites([
        { kind: 'result', jobId: ids[0], result: { n: 0 } },
        { kind: 'complete', jobId: ids[0], completedAt: 1, timeline: [] },
        { kind: 'result', jobId: ids[1], result: { n: 1 } },
        { kind: 'complete', jobId: ids[1], completedAt: 1, timeline: [] },
      ]);
      expect(outcome?.failedAt).toBe(2);
      expect((outcome?.error as Error).message).toBe('injected');
      expect(internals.db.inTransaction).toBe(false);
      expect(ids.map((id) => storage.getJobStateRaw(id))).toEqual(['completed', 'active']);
      expect(storage.getResult(ids[0])).toEqual({ n: 0 });
      expect(storage.hasResult(ids[1])).toBe(false);
    } finally {
      storage.close();
    }
  });

  test('a job still in the write buffer leaves the batch to scalar writes', () => {
    const storage = new SqliteStorage({
      path: tempPath(),
      writeBufferSize: 1_000,
      writeBufferFlushMs: 60_000,
    });
    const id = jobId('buffered-0');
    try {
      storage.insertJob(createJob(id, 'q', { data: {} }));
      expect(
        storage.commitCompletionWrites([
          { kind: 'result', jobId: id, result: { n: 0 } },
          { kind: 'complete', jobId: id, completedAt: 1, timeline: [] },
        ])
      ).toBeUndefined();
      expect(resultCount(storage)).toBe(0);
      expect((storage as unknown as Internals).db.inTransaction).toBe(false);
    } finally {
      storage.close();
    }
  });

  test('an already open transaction leaves the batch to scalar writes', () => {
    const storage = new SqliteStorage({ path: tempPath() });
    const db = (storage as unknown as Internals).db;
    const id = jobId('nested-0');
    try {
      storage.insertJobImmediate(createJob(id, 'q', { data: {} }));
      db.run('BEGIN');
      expect(
        storage.commitCompletionWrites([{ kind: 'result', jobId: id, result: { n: 0 } }])
      ).toBeUndefined();
      db.run('ROLLBACK');
      expect(resultCount(storage)).toBe(0);
    } finally {
      storage.close();
    }
  });
});
