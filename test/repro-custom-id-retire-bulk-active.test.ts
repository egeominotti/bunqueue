/**
 * REPRO — the remaining admission paths that retire a persisted generation without
 * `durable` must commit the retirement and the successor in one transaction:
 *
 * - `addBulk` (PUSHB) recycling terminal custom jobIds and replacing a waiting
 *   deduplication owner inside one batch;
 * - a single add that recycles a completed custom jobId while transferring the
 *   deduplication key of an ACTIVE owner (`transferActiveDedupJob`).
 *
 * Before the fix the retirement (and the active owner's key clear) committed on
 * its own and the successor only entered the 10 ms WriteBuffer, so a SIGKILL right
 * after the add left neither generation on disk and the key without an owner.
 *
 * Run: bun test test/repro-custom-id-retire-bulk-active.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLIENT_SRC = join(import.meta.dir, '..', 'src', 'client');

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bq-retire-paths-'));
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

/** Durable first generation: one completed job with a result and one DLQ entry. */
function terminalGenerations(queue: string, done: string, dlq: string | null): string {
  return `
import { Queue, Worker, shutdownManager } from ${JSON.stringify(CLIENT_SRC)};
const opts = { embedded: true, dataPath: Bun.argv[2] };
const queue = new Queue(${JSON.stringify(queue)}, opts);
const expected = ${dlq ? 2 : 1};
const settled = Promise.withResolvers();
let seen = 0;
const worker = new Worker(${JSON.stringify(queue)}, async (job) => {
  if (job.data.fail) throw new Error('boom');
  return { receipt: 'R-' + job.id };
}, opts);
const settle = () => { if (++seen === expected) settled.resolve(); };
worker.on('completed', settle);
worker.on('failed', settle);
${dlq ? `await queue.add('order', { fail: true }, { jobId: ${JSON.stringify(dlq)}, attempts: 1, durable: true });` : ''}
await queue.add('order', { fail: false }, { jobId: ${JSON.stringify(done)}, durable: true });
await settled.promise;
await worker.close();
`;
}

const BULK_PHASE_ONE = `${terminalGenerations('bulk', 'bulk-done', 'bulk-dlq')}
await queue.add('digest', { v: 1 }, { deduplication: { id: 'bk', replace: true }, durable: true });
queue.close();
shutdownManager();
`;

/** Buffered PUSHB recycling both custom ids and replacing the waiting owner, then a crash. */
const BULK_PHASE_TWO = `
import { Queue } from ${JSON.stringify(CLIENT_SRC)};
const queue = new Queue('bulk', { embedded: true, dataPath: Bun.argv[2] });
await queue.addBulk([
  { name: 'order', data: { gen: 2 }, opts: { jobId: 'bulk-dlq' } },
  { name: 'order', data: { gen: 2 }, opts: { jobId: 'bulk-done' } },
  { name: 'digest', data: { v: 2 }, opts: { deduplication: { id: 'bk', replace: true } } },
]);
process.kill(process.pid, 'SIGKILL');
`;

const ACTIVE_PHASE_ONE = `${terminalGenerations('swap', 'swap-done', null)}
queue.close();
shutdownManager();
`;

/** Active dedup owner, then a buffered add recycling a completed id onto its key, then a crash. */
const ACTIVE_PHASE_TWO = `
import { Queue, Worker } from ${JSON.stringify(CLIENT_SRC)};
const opts = { embedded: true, dataPath: Bun.argv[2] };
const queue = new Queue('swap', opts);
const started = Promise.withResolvers();
const worker = new Worker('swap', async () => {
  started.resolve();
  await new Promise(() => {});
}, opts);
await queue.add('owner', { v: 1 }, { deduplication: { id: 'ak' }, durable: true });
await started.promise;
await queue.add('swap', { gen: 2 }, { jobId: 'swap-done', deduplication: { id: 'ak', replace: true } });
process.kill(process.pid, 'SIGKILL');
`;

function query(dataPath: string, read: (has: (sql: string, ...p: string[]) => boolean) => object) {
  const db = new Database(dataPath, { readonly: true });
  try {
    return read((sql, ...params) => (db.query(sql).get(...params) as { c: number }).c > 0);
  } finally {
    db.close();
  }
}

const JOB = 'SELECT COUNT(*) AS c FROM jobs WHERE id = ?';
const DLQ = 'SELECT COUNT(*) AS c FROM dlq WHERE job_id = ?';
const KEY_OWNER = 'SELECT COUNT(*) AS c FROM jobs WHERE unique_key = ?';

describe('buffered admissions that retire a persisted generation', () => {
  test('PUSHB: a crash right after the batch leaves one generation per id and key', async () => {
    const dataPath = join(dir, 'bulk.db');
    const snapshot = () =>
      query(dataPath, (has) => ({
        done: has(JOB, 'bulk-done'),
        dlq: has(JOB, 'bulk-dlq') || has(DLQ, 'bulk-dlq'),
        keyOwner: has(KEY_OWNER, 'bk'),
      }));
    expect(await runChild('bulk-one', BULK_PHASE_ONE, dataPath)).toBe(0);
    expect(snapshot()).toEqual({ done: true, dlq: true, keyOwner: true });

    await runChild('bulk-two', BULK_PHASE_TWO, dataPath);
    expect(snapshot()).toEqual({ done: true, dlq: true, keyOwner: true });
  }, 90_000);

  test('active dedup transfer: a crash keeps the recycled id and an owner of the key', async () => {
    const dataPath = join(dir, 'active.db');
    const snapshot = () =>
      query(dataPath, (has) => ({ done: has(JOB, 'swap-done'), keyOwner: has(KEY_OWNER, 'ak') }));
    expect(await runChild('active-one', ACTIVE_PHASE_ONE, dataPath)).toBe(0);
    expect(snapshot()).toEqual({ done: true, keyOwner: false });

    await runChild('active-two', ACTIVE_PHASE_TWO, dataPath);
    expect(snapshot()).toEqual({ done: true, keyOwner: true });
  }, 90_000);
});
