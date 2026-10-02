/**
 * A timed `waitFor` expiring while a signal is delivered: the timeout and the signal
 * are decided by one claim at the database (src/client/workflow/storeWaitExpiry.ts).
 *
 * test/repro-workflow-signal-timeout-race.test.ts shows the original defect: the worker
 * re-read the row, found no signal, and then wrote `failed` unconditionally, so a
 * signal recorded from another connection in between was told it resumed the run. That
 * repro now lands on the timeout-wins side, because `signal:timeout` is emitted only
 * after the claim. These tests cover the rest of the decision table:
 *
 *   - the store claim itself, with two real connections to one SQLite file;
 *   - the signal winning against an expiring worker (resume claimed and published by
 *     the signaller), which must continue the run exactly once with no rollback;
 *   - the in-process `Engine.signal()` path, which must be rejected once the timeout
 *     has won;
 *   - recovery re-driving an elapsed deadline, where a signal recorded on the
 *     `running` row claims no resume and the worker is the only one left to advance.
 *
 * The signal-wins cases inject the cross-connection signal immediately before the
 * claim by wrapping `WorkflowStore.prototype.expireWait`, which is exactly the point
 * where the old two-step decision lost it, and makes the interleaving deterministic.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shutdownManager } from '../src/client';
import { Queue } from '../src/client/queue/queue';
import { Engine, Workflow } from '../src/client/workflow';
import type { Execution, WorkflowEvent } from '../src/client/workflow';
import { WorkflowStore } from '../src/client/workflow/store';

const realExpireWait = WorkflowStore.prototype.expireWait;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  WorkflowStore.prototype.expireWait = realExpireWait;
  while (cleanups.length) await cleanups.pop()?.();
});

function tempDataPath(prefix: string): string {
  shutdownManager();
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    shutdownManager();
    rmSync(dir, { recursive: true, force: true });
  });
  return join(dir, 'wf.db');
}

function openStore(dataPath: string): WorkflowStore {
  const store = new WorkflowStore(dataPath);
  cleanups.push(() => store.close());
  return store;
}

/** A run parked at a timed gate at node 0 whose budget is long spent. */
function parkedRun(id: string, workflowName: string, state: Execution['state']): Execution {
  const now = Date.now();
  return {
    id,
    workflowName,
    state,
    input: undefined,
    steps: { '__waitFor:approval': { status: 'running', startedAt: now - 60_000 } },
    currentNodeIndex: 0,
    signals: {},
    createdAt: now - 60_000,
    updatedAt: now - 60_000,
  };
}

/** The failure the worker would try to persist for `exec`. */
function failedCopy(exec: Execution): Execution {
  return {
    ...exec,
    state: 'failed',
    failureReason: 'Signal "approval" timed out after 10ms',
    steps: {
      ...exec.steps,
      '__waitFor:approval': { status: 'failed', startedAt: 0, completedAt: 1, error: 'x' },
    },
  };
}

async function waitUntil(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check()) && Date.now() < deadline) await Bun.sleep(10);
}

describe('WorkflowStore.expireWait: one claim decides timeout versus signal', () => {
  test('expiry first: the run fails durably and a late signal is rejected', () => {
    const dataPath = tempDataPath('bq-wf-expiry-first-');
    const worker = openStore(dataPath);
    const outside = openStore(dataPath);
    const exec = parkedRun('wf-expiry-first', 'gate', 'waiting');
    worker.save(exec);

    expect(worker.expireWait(failedCopy(exec), 'approval', 0)).toEqual({ kind: 'expired' });
    expect(() => outside.recordSignal(exec.id, 'approval', { ok: true })).toThrow(
      /cannot receive the signal/
    );

    const row = outside.get(exec.id);
    expect(row?.state).toBe('failed');
    expect(row?.failureReason).toContain('timed out');
    expect(row?.steps['__waitFor:approval']?.status).toBe('failed');
    expect(row?.signals).toEqual({});
  });

  test('signal first: the claim reports it and writes nothing, even with no payload', () => {
    const dataPath = tempDataPath('bq-wf-signal-first-');
    const worker = openStore(dataPath);
    const outside = openStore(dataPath);
    const exec = parkedRun('wf-signal-first', 'gate', 'waiting');
    worker.save(exec);

    // A payload-less approval records the key with an `undefined` value; it must still
    // count as having arrived (storeSignals.ts, hasSignal).
    const recorded = outside.recordSignal(exec.id, 'approval', undefined);
    expect(recorded.resumed).toBe(true);

    const outcome = worker.expireWait(failedCopy(exec), 'approval', 0);
    expect(outcome.kind).toBe('signalled');
    expect(outcome.kind === 'signalled' && Object.hasOwn(outcome.signals, 'approval')).toBe(true);

    const row = outside.get(exec.id);
    expect(row?.state).toBe('running');
    expect(row?.failureReason).toBeUndefined();
    expect(row?.steps['__waitFor:approval']?.status).toBe('running');
  });

  test('a run another driver moved on is neither failed nor reported as signalled', () => {
    const dataPath = tempDataPath('bq-wf-expiry-moved-');
    const store = openStore(dataPath);
    const advanced = { ...parkedRun('wf-advanced', 'gate', 'running'), currentNodeIndex: 1 };
    const finished = parkedRun('wf-finished', 'gate', 'completed');
    store.save(advanced);
    store.save(finished);

    // The advanced run is at node 1 with the signal present: reporting `signalled`
    // here would advance it a second time.
    store.recordSignal(advanced.id, 'approval', { ok: true });
    expect(store.expireWait(failedCopy(advanced), 'approval', 0)).toEqual({ kind: 'moved' });
    expect(store.expireWait(failedCopy(finished), 'approval', 0)).toEqual({ kind: 'moved' });

    expect(store.get(advanced.id)?.state).toBe('running');
    expect(store.get(advanced.id)?.currentNodeIndex).toBe(1);
    expect(store.get(finished.id)?.state).toBe('completed');
    expect(store.get(finished.id)?.failureReason).toBeUndefined();
  });
});

describe('Engine: a timed waitFor racing a signal', () => {
  test('a signal from another connection that wins the claim continues the run exactly once', async () => {
    const dataPath = tempDataPath('bq-wf-signal-wins-');
    const outside = openStore(dataPath);
    const steps = new Queue('__wf:steps', { embedded: true, dataPath });
    cleanups.push(() => steps.close());

    const events: WorkflowEvent['type'][] = [];
    let afterRuns = 0;
    let compensations = 0;
    const engine = new Engine({ embedded: true, dataPath, onEvent: (e) => events.push(e.type) });
    cleanups.push(() => engine.close(true));
    engine.register(
      new Workflow('claim-signal-wins')
        .step('reserve', () => ({ held: true }), {
          compensate: () => {
            compensations++;
          },
        })
        .waitFor('approval', { timeout: 100 })
        .step('after', () => {
          afterRuns++;
          return { ok: true };
        })
    );

    // Deliver the signal the way another process would, right before the claim: the
    // row is still `waiting`, so record() claims the resume and the signaller publishes
    // the resume job for the gate, exactly like Engine.signal() or the MCP tool.
    let recorded: ReturnType<WorkflowStore['recordSignal']> | null = null;
    let resumeJob: ReturnType<Queue['add']> | null = null;
    WorkflowStore.prototype.expireWait = function (this: WorkflowStore, failed, event, idx) {
      if (recorded === null) {
        recorded = outside.recordSignal(failed.id, event, { approved: true });
        if (recorded.resumed) {
          resumeJob = steps.add('wf:step', {
            executionId: failed.id,
            workflowName: recorded.workflowName,
            nodeIndex: recorded.currentNodeIndex,
          });
        }
      }
      return realExpireWait.call(this, failed, event, idx);
    };

    const run = await engine.start('claim-signal-wins');
    await waitUntil(() => engine.getExecution(run.id)?.state === 'completed');

    expect(recorded).not.toBeNull();
    expect(recorded!.resumed).toBe(true);
    expect(resumeJob).not.toBeNull();
    // The duplicate resume job must reach the worker and be discarded by admission,
    // not re-run the gate and the step after it.
    const job = await resumeJob!;
    await waitUntil(async () => (await job.getState()) === 'completed');
    expect(await job.getState()).toBe('completed');

    const exec = engine.getExecution(run.id);
    expect(exec?.state).toBe('completed');
    expect(exec?.failureReason).toBeUndefined();
    expect(exec?.signals).toEqual({ approval: { approved: true } });
    expect(afterRuns).toBe(1);
    expect(compensations).toBe(0);
    expect(events).not.toContain('signal:timeout');
    expect(events).not.toContain('workflow:failed');
  }, 15_000);

  test('Engine.signal() from a signal:timeout listener is rejected once the timeout won', async () => {
    const dataPath = tempDataPath('bq-wf-timeout-wins-');
    const events: WorkflowEvent['type'][] = [];
    let compensations = 0;
    let afterRan = false;
    let late: Promise<void> | null = null;
    // Assigned before any event can fire; the listener reads it at call time.
    const engine: Engine = new Engine({
      embedded: true,
      dataPath,
      onEvent: (event) => {
        events.push(event.type);
        if (event.type === 'signal:timeout') {
          late = engine.signal(event.executionId, 'approval', { approved: true });
          late.catch(() => {});
        }
      },
    });
    cleanups.push(() => engine.close(true));
    engine.register(
      new Workflow('claim-timeout-wins')
        .step('reserve', () => ({ held: true }), {
          compensate: () => {
            compensations++;
          },
        })
        .waitFor('approval', { timeout: 50 })
        .step('after', () => {
          afterRan = true;
        })
    );

    const run = await engine.start('claim-timeout-wins');
    await waitUntil(() => engine.getExecution(run.id)?.rollbackStatus !== undefined);

    expect(late).not.toBeNull();
    await expect(late!).rejects.toThrow(/cannot receive the signal/);
    const exec = engine.getExecution(run.id);
    expect(exec?.state).toBe('failed');
    expect(exec?.failureReason).toContain('Signal "approval" timed out after 50ms');
    expect(exec?.signals).toEqual({});
    expect(afterRan).toBe(false);
    expect(compensations).toBe(1);
    expect(events.indexOf('signal:timeout')).toBeLessThan(events.indexOf('workflow:failed'));
  }, 15_000);

  test('recovery re-driving an elapsed deadline advances when the signal lands on the running row', async () => {
    const dataPath = tempDataPath('bq-wf-recover-claim-');
    const outside = openStore(dataPath);
    // The run parked before a crash and its deadline passed while nothing was running.
    const seeded = parkedRun('wf-recover-claim', 'claim-recover', 'waiting');
    outside.save(seeded);

    const events: WorkflowEvent['type'][] = [];
    let afterRuns = 0;
    const engine = new Engine({ embedded: true, dataPath, onEvent: (e) => events.push(e.type) });
    cleanups.push(() => engine.close(true));
    engine.register(
      new Workflow('claim-recover').waitFor('approval', { timeout: 1_000 }).step('after', () => {
        afterRuns++;
      })
    );

    // recover() moves the row to `running` before it re-publishes the gate, so this
    // signal claims no resume and publishes nothing: the worker that loses the expiry
    // is the only driver left, and must advance rather than stand down.
    let recorded: ReturnType<WorkflowStore['recordSignal']> | null = null;
    WorkflowStore.prototype.expireWait = function (this: WorkflowStore, failed, event, idx) {
      recorded ??= outside.recordSignal(failed.id, event, { approved: true });
      return realExpireWait.call(this, failed, event, idx);
    };

    const recovered = await engine.recover();
    expect(recovered.waiting).toBe(1);
    await waitUntil(() => engine.getExecution(seeded.id)?.state === 'completed');

    expect(recorded).not.toBeNull();
    expect(recorded!.resumed).toBe(false);
    const exec = engine.getExecution(seeded.id);
    expect(exec?.state).toBe('completed');
    expect(exec?.failureReason).toBeUndefined();
    expect(afterRuns).toBe(1);
    expect(events).not.toContain('signal:timeout');
    expect(events).not.toContain('workflow:failed');
  }, 15_000);
});
