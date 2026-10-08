/**
 * Runs the ACK completion fault matrix and prints one JSON line per scenario.
 * Spawned by test/repro-write-path-faults.test.ts with
 * fixtures/pin-shard-count.ts preloaded, so shard routing (and therefore the
 * order in which a batch ACK extracts its jobs) matches the recorded fixture
 * on any host.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../../src/application/queueManager';

type Storage = {
  statements: Map<string, { run: (...args: unknown[]) => unknown }>;
  writeBuffer: { hasPending(id: string): boolean };
  flushWriteBuffer(): number;
  getJobStateRaw(id: unknown): string | null;
  getResult(id: unknown): unknown;
  getDiskFullStatus(): { diskFull: boolean };
};
type Internals = {
  storage: Storage;
  jobIndex: Map<unknown, { type: string }>;
  completedJobs: Set<unknown>;
  jobResults: { has(id: unknown): boolean };
};
type Inject = (storage: Storage) => () => void;

const runtime = Bun as unknown as { randomUUIDv7: () => string };
let counter = 0;
const logs: string[] = [];

// Deterministic job IDs keep extraction order identical across runs.
runtime.randomUUIDv7 = () => `0190f0e0-0000-7000-8000-${String(++counter).padStart(12, '0')}`;

function captureStorageLogs(): () => void {
  const saved = [console.error, console.log, console.info, console.warn] as const;
  const capture = (...args: unknown[]): void => {
    const line = args.map(String).join(' ');
    if (!line.includes('[Storage]')) return;
    logs.push(line.includes('DISK FULL') ? 'FULL' : line.includes('cleared') ? 'CLR' : 'OTHER');
  };
  console.error = capture;
  console.log = capture;
  console.info = capture;
  console.warn = capture;
  return () => {
    [console.error, console.log, console.info, console.warn] = saved;
  };
}

async function run(
  name: string,
  mode: 'scalar' | 'batch',
  durable: boolean,
  inject: Inject,
  resultFor: (index: number) => unknown
) {
  counter = 0;
  logs.length = 0;
  const directory = mkdtempSync(join(tmpdir(), 'bunqueue-write-faults-'));
  const manager = new QueueManager({ dataPath: join(directory, 'queue.db') });
  const internals = manager as unknown as Internals;
  const storage = internals.storage;
  try {
    const count = mode === 'batch' ? 6 : 1;
    for (let index = 0; index < count; index++)
      await manager.push('q', { data: { index }, durable });
    const jobs =
      mode === 'batch' ? await manager.pullBatch('q', count) : [(await manager.pull('q'))!];
    jobs.sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
    const buffered = jobs
      .map((job) => (storage.writeBuffer.hasPending(String(job.id)) ? 'B' : '.'))
      .join('');
    const restore = inject(storage);
    const release = captureStorageLogs();
    let threw: string | null = null;
    try {
      if (mode === 'batch') {
        await manager.ackBatchWithResults(
          jobs.map((job, index) => ({ id: job.id, result: resultFor(index) }))
        );
      } else {
        await manager.ack(jobs[0].id, resultFor(0));
      }
    } catch (error) {
      threw = (error as Error).message.slice(0, 25);
    }
    try {
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      release();
      restore();
    }
    const ackLogs = logs.join(',');
    try {
      storage.flushWriteBuffer();
    } catch {
      // Same best-effort flush as the reference run.
    }
    return {
      name,
      buffered,
      threw,
      disk: jobs.map((job) => storage.getJobStateRaw(job.id)?.[0] ?? '-').join(''),
      res: jobs.map((job) => (storage.getResult(job.id) !== null ? 'R' : '.')).join(''),
      idx: jobs.map((job) => internals.jobIndex.get(job.id)?.type?.[0] ?? '-').join(''),
      done: jobs.map((job) => (internals.completedJobs.has(job.id) ? 'C' : '.')).join(''),
      mres: jobs.map((job) => (internals.jobResults.has(job.id) ? 'R' : '.')).join(''),
      diskFull: storage.getDiskFullStatus().diskFull,
      ackLogs,
    };
  } finally {
    manager.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
}

const circular = (): unknown => {
  const value: Record<string, unknown> = { a: 1 };
  value.self = value;
  return value;
};
/** Fail the given (1-based) calls of one prepared statement with SQLITE_FULL. */
const failCalls =
  (name: string, which: (call: number) => boolean): Inject =>
  (storage) => {
    const real = storage.statements.get(name)!;
    let calls = 0;
    storage.statements.set(name, {
      run(...args: unknown[]) {
        calls++;
        if (which(calls)) throw new Error('SQLITE_FULL: database or disk is full');
        return real.run(...args);
      },
    });
    return () => storage.statements.set(name, real);
  };
const none: Inject = () => () => {};

const actual: unknown[] = [];
for (const durable of [true, false]) {
  const d = `d=${durable}`;
  const ok = () => ({ r: 1 });
  actual.push(await run(`scalar ok ${d}`, 'scalar', durable, none, ok));
  actual.push(await run(`batch ok ${d}`, 'batch', durable, none, ok));
  actual.push(await run(`scalar circular ${d}`, 'scalar', durable, none, circular));
  actual.push(
    await run(`batch circular@0 ${d}`, 'batch', durable, none, (i) =>
      i === 0 ? circular() : { i }
    )
  );
  actual.push(
    await run(`batch circular@3 ${d}`, 'batch', durable, none, (i) =>
      i === 3 ? circular() : { i }
    )
  );
  actual.push(
    await run(
      `scalar insertResult always ${d}`,
      'scalar',
      durable,
      failCalls('insertResult', () => true),
      ok
    )
  );
  actual.push(
    await run(
      `batch insertResult always ${d}`,
      'batch',
      durable,
      failCalls('insertResult', () => true),
      ok
    )
  );
  actual.push(
    await run(
      `scalar insertResult once ${d}`,
      'scalar',
      durable,
      failCalls('insertResult', (n) => n === 1),
      ok
    )
  );
  actual.push(
    await run(
      `batch insertResult once ${d}`,
      'batch',
      durable,
      failCalls('insertResult', (n) => n === 1),
      ok
    )
  );
  actual.push(
    await run(
      `batch insertResult 3rd-call-once ${d}`,
      'batch',
      durable,
      failCalls('insertResult', (n) => n === 3),
      ok
    )
  );
  actual.push(
    await run(
      `scalar completeJob always ${d}`,
      'scalar',
      durable,
      failCalls('completeJob', () => true),
      ok
    )
  );
  actual.push(
    await run(
      `batch completeJob always ${d}`,
      'batch',
      durable,
      failCalls('completeJob', () => true),
      ok
    )
  );
  actual.push(
    await run(
      `scalar completeJob once ${d}`,
      'scalar',
      durable,
      failCalls('completeJob', (n) => n === 1),
      ok
    )
  );
  actual.push(
    await run(
      `batch completeJob once ${d}`,
      'batch',
      durable,
      failCalls('completeJob', (n) => n === 1),
      ok
    )
  );
  actual.push(
    await run(
      `batch completeJob 2nd-once ${d}`,
      'batch',
      durable,
      failCalls('completeJob', (n) => n === 2),
      ok
    )
  );
  actual.push(
    await run(
      `batch noresult completeJob once ${d}`,
      'batch',
      durable,
      failCalls('completeJob', (n) => n === 1),
      () => undefined
    )
  );
  actual.push(
    await run(
      `batch mixed insertResult always ${d}`,
      'batch',
      durable,
      failCalls('insertResult', () => true),
      (i) => (i % 2 ? { i } : undefined)
    )
  );
  actual.push(
    await run(
      `batch mixed completeJob once ${d}`,
      'batch',
      durable,
      failCalls('completeJob', (n) => n === 1),
      (i) => (i % 2 ? { i } : undefined)
    )
  );
}
for (const row of actual) process.stdout.write(`${JSON.stringify(row)}\n`);
