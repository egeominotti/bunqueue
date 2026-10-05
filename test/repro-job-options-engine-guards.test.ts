/**
 * Repro: the engine turns an invalid job duration into a hot loop, a hang or a lost job.
 *
 * Boundary validation now rejects these values, but internal callers (the embedded
 * QueueManager API, legacy cron templates, persisted rows) can still hand the engine
 * a NaN. Before the fix:
 *
 * - a NaN delay gave `runAt = NaN`: the job was reported `waiting` but never pulled,
 *   every pull waiter re-polled every ~1 ms for its whole timeout, and the SQLite
 *   write buffer dropped the row (`NOT NULL constraint failed: jobs.run_at`);
 * - the same job in a group-scheduled queue looped forever inside one synchronous
 *   pull (promote, not ready, demote, promote...), freezing the process;
 * - `calculateBackoff` returned NaN for a NaN base and for `0 * 2^1024`;
 * - a backoff object without `delay`, or a NaN timestamp, was dropped by SQLite;
 * - the waiter armed `setTimeout` with any timeout, so one above 2^31 - 1 ms fired
 *   after ~1 ms and a NaN one spun.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import { WaiterManager } from '../src/domain/queue/waiterManager';
import { calculateBackoff, createJob, jobId, type Job } from '../src/domain/types/job';

const dirs: string[] = [];
let manager: QueueManager | null = null;

afterEach(() => {
  manager?.shutdown();
  manager = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'job-options-guards-'));
  dirs.push(dir);
  return join(dir, 'queue.db');
}

/** Count native setTimeout calls made while `body` runs. */
async function countTimers<T>(body: () => Promise<T>): Promise<{ value: T; timers: number }> {
  const original = globalThis.setTimeout;
  let timers = 0;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    timers++;
    return original(...args);
  }) as typeof setTimeout;
  try {
    return { value: await body(), timers };
  } finally {
    globalThis.setTimeout = original;
  }
}

describe('a NaN run time never reaches the scheduler', () => {
  test('a NaN delay is due now, pullable without re-polling, and persisted', async () => {
    const path = dataPath();
    manager = new QueueManager({ dataPath: path });
    const pushed = await manager.push('nan-delay', { data: { n: 1 }, delay: Number.NaN });
    const { value: pulled, timers } = await countTimers(() => manager!.pull('nan-delay', 300));
    expect({ pulled: pulled?.id ?? null, timers: Math.min(timers, 5) }).toEqual({
      pulled: pushed.id,
      timers: expect.any(Number),
    });
    expect(timers).toBeLessThan(5);

    const kept = await manager.push('nan-delay-kept', { data: {}, delay: Number.NaN });
    manager.shutdown();
    manager = new QueueManager({ dataPath: path });
    expect(await manager.getJobState(kept.id)).toBe('waiting');
  });

  test('a grouped job with a NaN delay does not freeze the process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'job-options-hang-'));
    dirs.push(dir);
    const script = join(dir, 'hang.ts');
    const source = resolve(import.meta.dir, '../src/application/queueManager.ts');
    writeFileSync(
      script,
      `import { QueueManager } from ${JSON.stringify(source)};
const qm = new QueueManager();
await qm.push('g', { data: {}, groupId: 'a', delay: Number.NaN });
const job = await qm.pull('g', 0);
console.log(job ? 'pulled' : 'empty');
qm.shutdown();
process.exit(0);
`
    );
    const child = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
    const outcome = await Promise.race([
      child.exited.then(() => 'exited'),
      Bun.sleep(5_000).then(() => 'frozen'),
    ]);
    if (outcome === 'frozen') child.kill(9);
    const output = await new Response(child.stdout).text();
    expect({ outcome, output: output.trim() }).toEqual({ outcome: 'exited', output: 'pulled' });
  }, 15_000);

  test('backoff without a usable delay and a NaN timestamp are persisted with defaults', async () => {
    const path = dataPath();
    manager = new QueueManager({ dataPath: path });
    const noDelay = await manager.push('defaults', {
      data: {},
      backoff: { type: 'fixed' } as never,
    });
    const nanBackoff = await manager.push('defaults', { data: {}, backoff: Number.NaN });
    const nanTimestamp = await manager.push('defaults', { data: {}, timestamp: Number.NaN });
    manager.shutdown();
    manager = new QueueManager({ dataPath: path });
    for (const pushed of [noDelay, nanBackoff, nanTimestamp]) {
      const job = await manager.getJob(pushed.id);
      expect(job).not.toBeNull();
      expect(Number.isFinite(job!.backoff)).toBe(true);
      expect(Number.isFinite(job!.createdAt)).toBe(true);
    }
  });
});

describe('calculateBackoff is always a finite delay', () => {
  function job(input: Partial<Job>): Job {
    return { ...createJob(jobId('backoff-job'), 'q', { data: {} }), ...input } as Job;
  }

  test('for any attempt count, including above 1023 with a zero base', () => {
    for (const attempts of [0, 1, 30, 1023, 1024, 5000, Number.MAX_SAFE_INTEGER]) {
      expect(calculateBackoff(job({ backoff: 0, attempts }))).toBe(0);
      const delay = calculateBackoff(job({ backoff: 1000, attempts }));
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
    const capped = { type: 'exponential' as const, delay: 0, maxDelay: 50 };
    expect(calculateBackoff(job({ backoffConfig: capped, attempts: 4000 }))).toBe(0);
  });

  test('for a NaN or missing base delay', () => {
    const missing = { type: 'exponential', delay: undefined } as unknown as Job['backoffConfig'];
    for (const input of [
      { backoff: Number.NaN },
      { backoffConfig: missing },
      { backoffConfig: { type: 'fixed' as const, delay: Number.NaN } },
    ]) {
      const delay = calculateBackoff(job({ ...input, attempts: 3 }));
      expect(Number.isFinite(delay)).toBe(true);
    }
  });
});

describe('the pull waiter never arms an out-of-range timer', () => {
  test('a timeout above 2^31 - 1 ms waits instead of firing after ~1 ms', async () => {
    const waiters = new WaiterManager();
    let resolved = false;
    const wait = waiters.waitForJob('q', 3e9).then(() => {
      resolved = true;
    });
    await Bun.sleep(30);
    expect(resolved).toBe(false);
    waiters.notify('q');
    await wait;
    expect(resolved).toBe(true);
  });

  test('a NaN timeout is rejected instead of re-polling every ~1 ms', async () => {
    const waiters = new WaiterManager();
    await expect(waiters.waitForJob('q', Number.NaN)).rejects.toThrow(TypeError);
    expect(waiters.length).toBe(0);
  });

  test('a job delayed to Infinity (a legacy row) is waited for without re-polling', async () => {
    const path = dataPath();
    manager = new QueueManager({ dataPath: path });
    const held = await manager.push('held', { data: {}, delay: Infinity, durable: true });
    manager.shutdown();
    manager = new QueueManager({ dataPath: path });
    expect(await manager.getJobState(held.id)).toBe('delayed');
    const { value, timers } = await countTimers(() => manager!.pull('held', 150));
    expect(value).toBeNull();
    expect(timers).toBeLessThan(5);
    expect(await manager.promote(held.id)).toBe(true);
    expect((await manager.pull('held', 0))?.id).toBe(held.id);
  });
});
