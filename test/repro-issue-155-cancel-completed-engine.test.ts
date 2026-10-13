/**
 * Issue #155 B, engine level: `cancel()` of a completed job leaves exactly the state
 * `removeOnComplete` would have left at completion time.
 *
 * Before the fix `cancelJob` handled only queued jobs, so every test below found the
 * completed job, its result and its counters untouched. The tests pin the decided
 * semantics: one SQLite transaction (row, result, payload-free proof with the original
 * completion time), coherent completed counters, a pinned proof while a dependent waits,
 * live flow consumers reading the child value exactly as for a removeOnComplete child,
 * and no memory change when the write fails.
 */
import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import type { JobId } from '../src/domain/types/job';
import type { JobEvent } from '../src/domain/types/queue';

let manager: QueueManager | null = null;
let directory: string | null = null;

afterEach(() => {
  manager?.shutdown();
  manager = null;
  if (directory) rmSync(directory, { force: true, recursive: true });
  directory = null;
});

function persistentManager(name: string, extra: Record<string, number> = {}) {
  directory = mkdtempSync(join(tmpdir(), `bunqueue-i155-${name}-`));
  const dataPath = join(directory, 'queue.db');
  manager = new QueueManager({ dataPath, dependencyCheckMs: 60_000, ...extra });
  return { dataPath, manager };
}

async function complete(target: QueueManager, queue: string, result: unknown, extra = {}) {
  const job = await target.push(queue, { data: { secret: 'payload' }, durable: true, ...extra });
  expect((await target.pull(queue))?.id).toBe(job.id);
  await target.ack(job.id, result);
  return job;
}

function row<T>(dataPath: string, sql: string, ...params: string[]): T | null {
  const db = new Database(dataPath, { readonly: true });
  try {
    return db.query(sql).get(...params) as T | null;
  } finally {
    db.close();
  }
}

test('one transaction deletes row and result, keeps the proof with the original completedAt', async () => {
  const { dataPath, manager: qm } = persistentManager('proof');
  const job = await complete(qm, 'proof', { answer: 4 });
  const completedAt = (await qm.getJob(job.id))!.completedAt!;
  qm.addLog(job.id, 'completed line');
  expect(qm.getLogs(job.id)).toHaveLength(1);
  expect(qm.getQueueJobCounts('proof').completed).toBe(1);
  const events: JobEvent[] = [];
  const unsubscribe = qm.subscribe((event) => events.push(event));

  await Bun.sleep(5);
  expect(await qm.cancel(job.id)).toBe(true);
  unsubscribe();

  expect(row(dataPath, 'SELECT id FROM jobs WHERE id = ?', job.id)).toBeNull();
  expect(row(dataPath, 'SELECT job_id FROM job_results WHERE job_id = ?', job.id)).toBeNull();
  expect(
    row(
      dataPath,
      'SELECT queue, completed_at, pinned FROM dependency_completions WHERE job_id = ?',
      job.id
    )
  ).toEqual({ queue: 'proof', completed_at: completedAt, pinned: 0 });
  expect(row(dataPath, "SELECT count FROM completed_job_counts WHERE queue = 'proof'")).toBeNull();
  expect(qm.getQueueJobCounts('proof').completed).toBe(0);
  expect(qm.getStats().completed).toBe(0);
  expect(qm.getResult(job.id)).toBeUndefined();
  expect(qm.getLogs(job.id)).toEqual([]);
  expect(events.filter((event) => event.eventType === 'removed')).toEqual([
    expect.objectContaining({ jobId: job.id, queue: 'proof', prev: 'completed' }),
  ]);
});

test('a failed write changes nothing: the job, its result and its counters stay', async () => {
  const { dataPath, manager: qm } = persistentManager('atomic');
  const job = await complete(qm, 'atomic', { answer: 7 });
  const writer = new Database(dataPath);
  writer.run(`CREATE TRIGGER i155_block BEFORE DELETE ON job_results
              BEGIN SELECT RAISE(ABORT, 'injected result delete failure'); END`);

  await expect(qm.cancel(job.id)).rejects.toThrow('injected result delete failure');

  expect(await qm.getJobState(job.id)).toBe('completed');
  expect(qm.getResult(job.id)).toEqual({ answer: 7 });
  expect(qm.getQueueJobCounts('atomic').completed).toBe(1);
  expect(row(dataPath, 'SELECT state FROM jobs WHERE id = ?', job.id)).toEqual({
    state: 'completed',
  });
  expect(
    row(dataPath, 'SELECT job_id FROM dependency_completions WHERE job_id = ?', job.id)
  ).toBeNull();

  writer.run('DROP TRIGGER i155_block');
  writer.close();
  expect(await qm.cancel(job.id)).toBe(true);
  expect(await qm.getJobState(job.id)).toBe('unknown');
});

test('the proof is pinned while a dependent waits, and still releases that dependent', async () => {
  const { dataPath, manager: qm } = persistentManager('pinned');
  const first = await complete(qm, 'pinned-deps', 'first');
  const second = await qm.push('pinned-deps', { data: {}, durable: true });
  const dependent = await qm.push('pinned-dependent', {
    data: {},
    durable: true,
    dependsOn: [first.id, second.id],
  });
  expect(await qm.getJobState(dependent.id)).toBe('waiting-children');

  expect(await qm.cancel(first.id)).toBe(true);
  expect(
    row(dataPath, 'SELECT pinned FROM dependency_completions WHERE job_id = ?', first.id)
  ).toEqual({ pinned: 1 });

  expect((await qm.pull('pinned-deps'))?.id).toBe(second.id);
  await qm.ack(second.id, 'second');
  for (let i = 0; i < 200 && (await qm.getJobState(dependent.id)) !== 'waiting'; i++) {
    await Bun.sleep(5);
  }
  expect(await qm.getJobState(dependent.id)).toBe('waiting');
});

test('a completed job evicted from memory is still removed from SQLite', async () => {
  const { dataPath, manager: qm } = persistentManager('evicted', { maxCompletedJobs: 2 });
  const oldest = await complete(qm, 'evicted', 'old');
  for (let i = 0; i < 3; i++) await complete(qm, 'evicted', i);
  expect(qm.getCompletedJobs().has(oldest.id)).toBe(false);
  expect(await qm.getJobState(oldest.id)).toBe('completed');

  expect(await qm.cancel(oldest.id)).toBe(true);

  expect(await qm.getJobState(oldest.id)).toBe('unknown');
  expect(row(dataPath, 'SELECT id FROM jobs WHERE id = ?', oldest.id)).toBeNull();
  expect(row(dataPath, 'SELECT job_id FROM job_results WHERE job_id = ?', oldest.id)).toBeNull();
  expect(qm.getQueueJobCounts('evicted').completed).toBe(3);
});

test('without persistence the job leaves every projection and the counters', async () => {
  manager = new QueueManager({ dependencyCheckMs: 60_000 });
  const job = await complete(manager, 'memory', { value: 1 });
  manager.addLog(job.id, 'line');

  expect(await manager.cancel(job.id)).toBe(true);

  expect(await manager.getJobState(job.id)).toBe('unknown');
  expect(await manager.getJob(job.id)).toBeNull();
  expect(manager.getResult(job.id)).toBeUndefined();
  expect(manager.getLogs(job.id)).toEqual([]);
  expect(manager.getQueueJobCounts('memory').completed).toBe(0);
  expect(manager.getDepCompletions().has(job.id)).toBe(true);
});

/** The parent's view of one child, keyed and valued as getChildrenValues reports it. */
async function childEntry(qm: QueueManager, parent: JobId, child: JobId) {
  const values = await qm.getChildrenValues(parent);
  return Object.entries(values).find(([key]) => key.endsWith(String(child))) ?? null;
}

test('a live flow parent reads a removed child exactly like a removeOnComplete child', async () => {
  const { manager: qm } = persistentManager('flow');
  const removedLater = await qm.push('flow-children', { data: {}, durable: true });
  const removedOnComplete = await qm.push('flow-children', {
    data: {},
    durable: true,
    removeOnComplete: true,
  });
  const children = [removedLater.id, removedOnComplete.id];
  const parent = await qm.push('flow-parent', {
    data: {},
    durable: true,
    dependsOn: children,
    childrenIds: children,
  });
  for (const id of children) {
    expect((await qm.pull('flow-children'))?.id).toBe(id);
    await qm.ack(id, { child: String(id) });
  }

  expect(await qm.cancel(removedLater.id)).toBe(true);

  expect(await childEntry(qm, parent.id, removedLater.id)).toEqual([
    String(removedLater.id),
    { child: String(removedLater.id) },
  ]);
  expect(await childEntry(qm, parent.id, removedOnComplete.id)).toEqual([
    String(removedOnComplete.id),
    { child: String(removedOnComplete.id) },
  ]);
});

test('a consumer registered after the result left the cache still reads it after removal', async () => {
  const { manager: qm } = persistentManager('late-consumer', { maxJobResults: 1 });
  const child = await complete(qm, 'late-children', { late: true });
  await complete(qm, 'late-children', 'evicts the cached result');
  const parent = await qm.push('late-parent', {
    data: {},
    durable: true,
    dependsOn: [child.id],
    childrenIds: [child.id],
  });
  expect(await childEntry(qm, parent.id, child.id)).toEqual([
    `late-children:${child.id}`,
    { late: true },
  ]);

  expect(await qm.cancel(child.id)).toBe(true);

  expect(await childEntry(qm, parent.id, child.id)).toEqual([String(child.id), { late: true }]);
});
