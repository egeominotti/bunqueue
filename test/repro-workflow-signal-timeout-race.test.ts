/**
 * REPRO — Workflow Engine: a signal recorded from another connection while a timed
 * `waitFor` is expiring is reported as resuming the run, yet the run still fails by
 * timeout.
 *
 * Run: bun test test/repro-workflow-signal-timeout-race.test.ts
 *
 * When the wait budget is spent, runWaitFor (src/client/workflow/waitFor.ts) re-reads
 * the store, finds no signal, emits `signal:timeout`, and then persists `failed`
 * unconditionally. A signal written by a second process (another app instance or the
 * MCP `bunqueue_signal_workflow` tool) between that re-read and the failing write is
 * accepted with `resumed: true`, but the failing write then overwrites the run:
 *
 *   worker: re-read -> no signal -> emit signal:timeout
 *   other:  recordSignal -> { found: true, resumed: true }   (signal stored)
 *   worker: update(exec { state: 'failed' }) + compensation
 *
 * The approver is told the run continues while it actually failed. The `signal:timeout`
 * listener runs synchronously inside that window, so recording from it is deterministic.
 *
 * Asserts the consistent outcome: a signal that reports `resumed: true` must lead to a
 * completed run; a run that fails by timeout must not have accepted a resuming signal.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shutdownManager } from '../src/client';
import { Queue } from '../src/client/queue/queue';
import { Engine, Workflow } from '../src/client/workflow';
import { WorkflowStore } from '../src/client/workflow/store';

describe('REPRO: a signal racing a waitFor timeout from another connection', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  test('a signal reported as resuming the run is never followed by a timeout failure', async () => {
    shutdownManager();
    const dir = mkdtempSync(join(tmpdir(), 'bunqueue-wf-timeout-race-'));
    const dataPath = join(dir, 'wf.db');
    cleanups.push(() => {
      shutdownManager();
      rmSync(dir, { recursive: true, force: true });
    });

    // A second connection to the same file, as another process would have.
    const outside = new WorkflowStore(dataPath);
    cleanups.push(() => outside.close());

    // The other side publishes the resume job exactly like Engine.signal() does when
    // its record() call claims the resume.
    const steps = new Queue('__wf:steps', { embedded: true, dataPath });
    cleanups.push(() => steps.close());

    // Typed through a getter: TypeScript cannot see the listener's assignment and
    // would otherwise narrow `outcome` to null for the rest of the test.
    type Outcome = { found: boolean; resumed: boolean; rejected?: string };
    let outcome = null as Outcome | null;
    const current = (): Outcome | null => outcome;
    let published: Promise<unknown> = Promise.resolve();
    let afterRan = false;
    const engine = new Engine({
      embedded: true,
      dataPath,
      onEvent: (event) => {
        if (event.type !== 'signal:timeout' || outcome !== null) return;
        try {
          const recorded = outside.recordSignal(event.executionId, 'approval', { approved: true });
          outcome = recorded;
          if (recorded.resumed) {
            published = steps.add('wf:step', {
              executionId: event.executionId,
              workflowName: recorded.workflowName,
              nodeIndex: recorded.currentNodeIndex,
            });
          }
        } catch (err) {
          // Rejecting the late signal is a consistent outcome too.
          outcome = { found: true, resumed: false, rejected: String(err) };
        }
      },
    });
    cleanups.push(() => engine.close(true));
    engine.register(
      new Workflow('timeout-race').waitFor('approval', { timeout: 100 }).step('after', () => {
        afterRan = true;
        return { ok: true };
      })
    );

    const run = await engine.start('timeout-race');
    const deadline = Date.now() + 5000;
    const settled = () => {
      const state = engine.getExecution(run.id)?.state;
      return state === 'failed' || state === 'completed';
    };
    while (!settled() && Date.now() < deadline) await Bun.sleep(10);
    await published;
    // Leave room for the resume job published by the other side to run.
    while (
      current()?.resumed &&
      engine.getExecution(run.id)?.state !== 'completed' &&
      Date.now() < deadline
    ) {
      await Bun.sleep(10);
    }

    const exec = engine.getExecution(run.id);
    const final = current();
    expect(final).not.toBeNull();
    if (final?.resumed) {
      expect(exec?.state).toBe('completed');
      expect(afterRan).toBe(true);
    } else {
      expect(exec?.state).toBe('failed');
      expect(afterRan).toBe(false);
    }
  }, 15_000);
});
