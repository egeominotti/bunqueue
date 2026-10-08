/**
 * REPRO — re-adding a terminal custom jobId (or replacing a deduplicated job) without
 * `durable` is not atomic: the previous generation is deleted from SQLite at once,
 * while its successor only enters the 10 ms WriteBuffer.
 *
 * Run: bun test test/repro-custom-id-retire-not-atomic.test.ts
 *
 * `SqliteJobLifecycle.insertJob` (src/infrastructure/persistence/sqlite/
 * jobLifecycle.ts) commits the admission metadata — deleting the retired job row,
 * its result, its DLQ entry and its dependency/flow records — in its own transaction
 * (`commitBufferedAdmissionMetadata`), then buffers the new row. A crash inside the
 * buffer window leaves NEITHER generation on disk: a DLQ entry, a completed job with
 * its result, and a waiting deduplicated job all disappear together with their
 * replacements. docs/features/deduplication-and-unique.md promises that the
 * admission "retires the exact persisted generation and inserts the durable
 * successor in one transaction".
 *
 * Contract pinned here: after a SIGKILL right after such an add, every id still has
 * exactly one generation on disk — the previous one or its successor — never none.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLIENT_SRC = join(import.meta.dir, '..', 'src', 'client');

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bq-retire-'));
});

afterEach(() => {
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

async function runChild(name: string, script: string, dataPath: string): Promise<number> {
  const path = join(dir, `${name}.ts`);
  writeFileSync(path, script);
  const proc = Bun.spawn(['bun', path, dataPath], { stdout: 'pipe', stderr: 'pipe' });
  const exited = await Promise.race([proc.exited, Bun.sleep(30_000).then(() => null)]);
  if (exited === null) proc.kill('SIGKILL');
  return proc.exited;
}

/** Durable first generation: a completed job with a result, a DLQ entry, a dedup owner. */
const PHASE_ONE = `
import { Queue, Worker, shutdownManager } from ${JSON.stringify(CLIENT_SRC)};
const opts = { embedded: true, dataPath: Bun.argv[2] };
const queue = new Queue('orders', opts);
const settled = Promise.withResolvers();
let seen = 0;
const worker = new Worker('orders', async (job) => {
  if (job.data.fail) throw new Error('boom');
  return { receipt: 'R-' + job.id };
}, opts);
const settle = () => { if (++seen === 2) settled.resolve(); };
worker.on('completed', settle);
worker.on('failed', settle);
await queue.add('order', { fail: true }, { jobId: 'order-dlq', attempts: 1, durable: true });
await queue.add('order', { fail: false }, { jobId: 'order-done', durable: true });
await settled.promise;
await worker.close();
const dedup = new Queue('digest', opts);
await dedup.add('digest', { v: 1 }, { deduplication: { id: 'dk', replace: true }, durable: true });
dedup.close();
queue.close();
shutdownManager();
`;

/** Buffered second generation, then a crash inside the write-buffer window. */
const PHASE_TWO = `
import { Queue } from ${JSON.stringify(CLIENT_SRC)};
const opts = { embedded: true, dataPath: Bun.argv[2] };
const queue = new Queue('orders', opts);
const dedup = new Queue('digest', opts);
await queue.add('order', { gen: 2 }, { jobId: 'order-dlq' });
await queue.add('order', { gen: 2 }, { jobId: 'order-done' });
await dedup.add('digest', { v: 2 }, { deduplication: { id: 'dk', replace: true } });
process.kill(process.pid, 'SIGKILL');
`;

function snapshot(dataPath: string) {
  const db = new Database(dataPath, { readonly: true });
  try {
    const has = (sql: string, ...params: string[]) =>
      (db.query(sql).get(...params) as { c: number }).c > 0;
    return {
      orderDone: has('SELECT COUNT(*) AS c FROM jobs WHERE id = ?', 'order-done'),
      orderDoneResult: has('SELECT COUNT(*) AS c FROM job_results WHERE job_id = ?', 'order-done'),
      orderDlq:
        has('SELECT COUNT(*) AS c FROM jobs WHERE id = ?', 'order-dlq') ||
        has('SELECT COUNT(*) AS c FROM dlq WHERE job_id = ?', 'order-dlq'),
      digest: has("SELECT COUNT(*) AS c FROM jobs WHERE queue = 'digest'"),
    };
  } finally {
    db.close();
  }
}

describe('custom jobId / dedup replace admission without durable', () => {
  test('a crash right after the re-add leaves one generation per id, never none', async () => {
    const dataPath = join(dir, 'q.db');
    expect(await runChild('phase-one', PHASE_ONE, dataPath)).toBe(0);
    expect(snapshot(dataPath)).toEqual({
      orderDone: true,
      orderDoneResult: true,
      orderDlq: true,
      digest: true,
    });

    await runChild('phase-two', PHASE_TWO, dataPath);
    const after = snapshot(dataPath);
    expect({ orderDone: after.orderDone, orderDlq: after.orderDlq, digest: after.digest }).toEqual({
      orderDone: true,
      orderDlq: true,
      digest: true,
    });
  }, 90_000);
});
