/**
 * Issue #39: SandboxedWorker.stop() drains the active jobs before it terminates the
 * threads, and pulls no new job while it drains.
 *
 * Real Bun Worker threads and a real embedded QueueManager. The processor holds each
 * job until a gate file exists, so the test decides when a job may finish: stop() is
 * called while the job is provably still active, must not resolve while it runs, and
 * resolves with the result stored once the gate opens. No fixed sleep decides an
 * outcome; the one bounded wait only shows that stop() is still pending.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import { SandboxedWorker } from '../src/client/sandboxed';

/** How long stop() must stay pending while a gated job runs. */
const PENDING_MS = 300;

let dir = '';
let manager: QueueManager;
let worker: SandboxedWorker | null = null;

const GATED_PROCESSOR = `
import { existsSync } from 'node:fs';
export default async (job) => {
  while (!existsSync(job.data.gate)) await Bun.sleep(5);
  return { doubled: job.data.value * 2 };
};
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bunqueue-sandboxed-stop-'));
  writeFileSync(join(dir, 'processor.ts'), GATED_PROCESSOR);
  manager = new QueueManager();
});

afterEach(async () => {
  // A failed assertion leaves the gate closed: open it so a draining stop() can end.
  writeFileSync(join(dir, 'gate'), '');
  await worker?.stop(true).catch(() => undefined);
  worker = null;
  await manager.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

function queueName(label: string): string {
  return `sandboxed-stop-${label}-${crypto.randomUUID()}`;
}

function startWorker(queue: string, concurrency: number): SandboxedWorker {
  worker = new SandboxedWorker(queue, {
    processor: join(dir, 'processor.ts'),
    concurrency,
    timeout: 20_000,
    manager,
  });
  return worker;
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

/** Calls stop() and reports whether it is still pending after PENDING_MS. */
async function stopAndCheckPending(
  target: SandboxedWorker
): Promise<{ stopping: Promise<void>; pending: boolean }> {
  let settled = false;
  const stopping = target.stop().finally(() => {
    settled = true;
  });
  await Bun.sleep(PENDING_MS);
  return { stopping, pending: !settled };
}

describe('Issue #39: SandboxedWorker.stop() drains active jobs', () => {
  test('stop() waits for the active job and stores its result', async () => {
    const queue = queueName('one');
    const target = startWorker(queue, 1);
    const active: string[] = [];
    const completed: string[] = [];
    target
      .on('active', (job) => active.push(String(job.id)))
      .on('completed', (job) => completed.push(String(job.id)));
    await target.start();

    const job = await manager.push(queue, { data: { value: 21, gate: join(dir, 'gate') } });
    await waitFor(() => active.length === 1, 'the job to become active');
    expect(await manager.getJobState(job.id)).toBe('active');

    const { stopping, pending } = await stopAndCheckPending(target);
    expect({ pending, completed: completed.length }).toEqual({ pending: true, completed: 0 });
    expect(await manager.getJobState(job.id)).toBe('active');

    writeFileSync(join(dir, 'gate'), '');
    await stopping;

    expect(completed).toEqual([String(job.id)]);
    expect(manager.getResult(job.id)).toEqual({ doubled: 42 });
    expect(await manager.getJobState(job.id)).toBe('completed');
    expect(target.getStats().total).toBe(0);
    expect(target.isRunning()).toBe(false);
  }, 30_000);

  test('stop() drains three concurrent active jobs', async () => {
    const queue = queueName('three');
    const target = startWorker(queue, 3);
    const active = new Set<string>();
    const completed = new Set<string>();
    target
      .on('active', (job) => active.add(String(job.id)))
      .on('completed', (job) => completed.add(String(job.id)));
    await target.start();

    const gate = join(dir, 'gate');
    const jobs = await Promise.all(
      [1, 2, 3].map((value) => manager.push(queue, { data: { value, gate } }))
    );
    await waitFor(() => active.size === 3, 'three active jobs');

    const { stopping, pending } = await stopAndCheckPending(target);
    expect({ pending, completed: completed.size }).toEqual({ pending: true, completed: 0 });

    writeFileSync(gate, '');
    await stopping;

    expect([...completed].sort()).toEqual(jobs.map((job) => String(job.id)).sort());
    for (const job of jobs) {
      const value = (job.data as { value: number }).value;
      expect(manager.getResult(job.id)).toEqual({ doubled: value * 2 });
      expect(await manager.getJobState(job.id)).toBe('completed');
    }
    expect(manager.getQueueJobCounts(queue)).toMatchObject({ waiting: 0, active: 0 });
  }, 30_000);

  test('stop() pulls no new job while it drains, even into a thread that became idle', async () => {
    const queue = queueName('nopull');
    const target = startWorker(queue, 2);
    const active: string[] = [];
    const completed: string[] = [];
    target
      .on('active', (job) => active.push(String(job.id)))
      .on('completed', (job) => completed.push(String(job.id)));
    await target.start();

    // Two threads, each held by its own gate; the third job waits for a free thread.
    const slow = await manager.push(queue, { data: { value: 1, gate: join(dir, 'gate') } });
    const quick = await manager.push(queue, { data: { value: 2, gate: join(dir, 'gate-q') } });
    await waitFor(() => active.length === 2, 'two active jobs');
    const waiting = await manager.push(queue, { data: { value: 3, gate: join(dir, 'gate') } });

    let settled = false;
    const stopping = target.stop().finally(() => {
      settled = true;
    });
    // One thread finishes during the drain; the other job keeps the drain going.
    writeFileSync(join(dir, 'gate-q'), '');
    await waitFor(() => completed.length === 1, 'the quick job to complete');
    await Bun.sleep(PENDING_MS);
    expect({ settled, active: active.length }).toEqual({ settled: false, active: 2 });
    expect(await manager.getJobState(waiting.id)).toBe('waiting');

    writeFileSync(join(dir, 'gate'), '');
    await stopping;

    expect(active.sort()).toEqual([String(slow.id), String(quick.id)].sort());
    expect(completed.sort()).toEqual([String(slow.id), String(quick.id)].sort());
    expect(await manager.getJobState(waiting.id)).toBe('waiting');
    expect(manager.getQueueJobCounts(queue)).toMatchObject({ waiting: 1, active: 0 });
  }, 30_000);
});
