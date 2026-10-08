/**
 * REPRO — `await queue.close()` resolves while the jobs that queue added are still
 * only in the SQLite WriteBuffer.
 *
 * Run: bun test test/repro-embedded-close-exit-loses-buffered-jobs.test.ts
 *
 * The WriteBuffer (src/infrastructure/persistence/writeBuffer.ts) flushes when it
 * holds 100 jobs or every 10 ms. `Queue.close()` (src/client/queue/runtime/
 * connection.ts) only stops the add batcher and releases the connection, so a script
 * that awaits every `add()`, awaits `close()` and then calls `process.exit()` loses
 * every job past the last multiple of 100: measured 10 -> 0, 50 -> 0, 99 -> 0,
 * 150 -> 100. Because `close()` alone leaves the process alive
 * (test/repro-embedded-close-hangs.test.ts), a bare `process.exit()` is exactly what
 * people reach for.
 *
 * Contract pinned here: once `add()` has resolved and `close()` has resolved, the job
 * survives `process.exit()`. `shutdownManager()` is still what stops the process-wide
 * timers; this only requires that closing a Queue does not strand its own writes.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLIENT_SRC = join(import.meta.dir, '..', 'src', 'client');

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bq-close-exit-'));
});

afterEach(() => {
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

/** Run `script` in a child process and return how many jobs reached the database. */
async function persistedAfter(script: string): Promise<number> {
  const path = join(dir, 'child.ts');
  const dataPath = join(dir, 'q.db');
  writeFileSync(path, script);
  const proc = Bun.spawn(['bun', path, dataPath], { stdout: 'pipe', stderr: 'pipe' });
  const exited = await Promise.race([proc.exited, Bun.sleep(20_000).then(() => null)]);
  if (exited === null) proc.kill('SIGKILL');
  const code = await proc.exited;
  if (code !== 0)
    throw new Error(`child exited ${code}: ${await new Response(proc.stderr).text()}`);

  const db = new Database(dataPath, { readonly: true });
  try {
    const row = db.query("SELECT COUNT(*) AS c FROM jobs WHERE queue = 'tasks'").get() as {
      c: number;
    };
    return row.c;
  } finally {
    db.close();
  }
}

describe('embedded Queue.close() then process.exit()', () => {
  for (const count of [10, 99, 150]) {
    test(`keeps all ${count} awaited add() jobs`, async () => {
      const script = `
import { Queue } from ${JSON.stringify(CLIENT_SRC)};
const queue = new Queue('tasks', { embedded: true, dataPath: Bun.argv[2] });
for (let i = 0; i < ${count}; i++) await queue.add('job', { i });
await queue.close();
process.exit(0);
`;
      expect(await persistedAfter(script)).toBe(count);
    }, 60_000);
  }

  test('keeps an awaited addBulk() batch', async () => {
    const script = `
import { Queue } from ${JSON.stringify(CLIENT_SRC)};
const queue = new Queue('tasks', { embedded: true, dataPath: Bun.argv[2] });
await queue.addBulk(Array.from({ length: 42 }, (_, i) => ({ name: 'job', data: { i } })));
await queue.close();
process.exit(0);
`;
    expect(await persistedAfter(script)).toBe(42);
  }, 60_000);
});
