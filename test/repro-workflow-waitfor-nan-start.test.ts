/**
 * REPRO — Workflow Engine: a parked `waitFor` whose persisted start time is not a
 * number must fail that run cleanly, not stop recovery or spin.
 *
 * Run: bun test test/repro-workflow-waitfor-nan-start.test.ts
 *
 * The wait budget left is `timeout - (now - startedAt)`. With a NaN `startedAt` (a
 * corrupted row) it is NaN. `recoverWaiting` (src/client/workflow/recovery.ts) then
 * armed a timer for NaN through `scheduleTimeoutCheck` (waitFor.ts), whose
 * `clampTimerDelay` throws a TypeError, so `recover()` rejected and every run after the
 * corrupted one stayed unrecovered. Before that, NaN reached `setTimeout`, which fired
 * after 1 ms; the re-check found `now - NaN >= timeout` false, parked again and armed
 * NaN again: a re-check job every millisecond, and the run never failed.
 *
 * Asserts the explicit handling: the corrupted gate fails through the normal expiry
 * claim with a reason that names it, every other parked run is recovered, and a NaN
 * delay handed to `scheduleTimeoutCheck` re-checks at once instead of throwing.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shutdownManager } from '../src/client';
import type { Queue } from '../src/client/queue/queue';
import { Engine, Workflow } from '../src/client/workflow';
import {
  resetClock,
  setClock,
  simulatedClock,
  type TimerHandle,
} from '../src/client/workflow/clock';
import { WorkflowStore } from '../src/client/workflow/store';
import { scheduleTimeoutCheck } from '../src/client/workflow/waitFor';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  resetClock();
  while (cleanups.length) await cleanups.pop()?.();
});

function gate(): Workflow {
  return new Workflow('nan-gate')
    .waitFor('approval', { timeout: 60_000 })
    .step('after', () => ({ ok: true }));
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await Bun.sleep(10);
}

function liveTimers(engine: Engine): Map<string, unknown> {
  return (engine as unknown as { executor: { timeoutTimers: Map<string, unknown> } }).executor
    .timeoutTimers;
}

describe('REPRO: a waitFor whose persisted start time is not a number', () => {
  test('recover() fails the corrupted gate cleanly and still recovers the others', async () => {
    shutdownManager();
    const dir = mkdtempSync(join(tmpdir(), 'bunqueue-wf-nan-start-'));
    const dataPath = join(dir, 'wf.db');
    cleanups.push(() => {
      shutdownManager();
      rmSync(dir, { recursive: true, force: true });
    });

    const first = new Engine({ embedded: true, dataPath });
    first.register(gate());
    const corrupted = await first.start('nan-gate');
    const healthy = await first.start('nan-gate');
    await until(
      () =>
        first.getExecution(corrupted.id)?.state === 'waiting' &&
        first.getExecution(healthy.id)?.state === 'waiting'
    );
    expect(first.getExecution(healthy.id)?.state).toBe('waiting');
    await first.close();

    // Corrupt one run, then touch the other so recovery reaches the corrupted run first.
    const store = new WorkflowStore(dataPath);
    const row = store.get(corrupted.id);
    if (!row) throw new Error('the corrupted run is missing');
    (row.steps['__waitFor:approval'] as { startedAt: number }).startedAt = NaN;
    store.update(row);
    const other = store.get(healthy.id);
    if (!other) throw new Error('the healthy run is missing');
    await Bun.sleep(5);
    store.update(other);
    store.close();

    const second = new Engine({ embedded: true, dataPath });
    cleanups.push(() => second.close(true));
    second.register(gate());
    const result = await second.recover();
    expect(result.waiting).toBe(2);

    await until(() => second.getExecution(corrupted.id)?.state === 'failed');
    const failed = second.getExecution(corrupted.id);
    expect(failed?.state).toBe('failed');
    expect(failed?.failureReason).toContain('"approval"');
    expect(failed?.failureReason).toContain('NaN');

    expect(second.getExecution(healthy.id)?.state).toBe('waiting');
    expect(liveTimers(second).has(healthy.id)).toBe(true);
    await second.signal(healthy.id, 'approval', { approved: true });
    await until(() => second.getExecution(healthy.id)?.state === 'completed');
    expect(second.getExecution(healthy.id)?.state).toBe('completed');
  }, 20_000);

  test('scheduleTimeoutCheck with a NaN delay re-checks at once instead of throwing', async () => {
    const sim = simulatedClock(7);
    setClock(sim);
    const added: unknown[] = [];
    const timers = new Map<string, TimerHandle>();
    const deps = {
      queue: {
        add: (_name: string, data: unknown) => {
          added.push(data);
          return Promise.resolve({ id: 'job' });
        },
      } as unknown as Queue,
      timers,
      assertActive: () => {},
      isActive: () => true,
    };

    expect(() => scheduleTimeoutCheck(deps, 'exec-1', 'nan-gate', 0, NaN)).not.toThrow();
    expect(timers.has('exec-1')).toBe(true);
    expect(sim.advance(0)).toBe(1);
    expect(added).toEqual([{ executionId: 'exec-1', workflowName: 'nan-gate', nodeIndex: 0 }]);
    await Bun.sleep(0);
    expect(timers.has('exec-1')).toBe(false);
  });
});
