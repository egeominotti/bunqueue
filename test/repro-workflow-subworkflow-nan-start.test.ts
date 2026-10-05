/**
 * REPRO — Workflow Engine: a sub-workflow child whose start time is not a number must
 * fail the parent node with a clear error, not poll forever or throw a timer error.
 *
 * Run: bun test test/repro-workflow-subworkflow-nan-start.test.ts
 *
 * `executeSubWorkflow` (src/client/workflow/subWorkflowRunner.ts) bounds its polling by
 * `maxWaitMs - (now - startedAt)`, with `startedAt` read from the child's row. With a
 * NaN `createdAt` (a corrupted row) the remaining budget is NaN: `remaining <= 0` is
 * false, so it never timed out, and the NaN poll delay reached `setTimeout`, which fired
 * after 1 ms, polling every millisecond. Through `clampTimerDelay` it threw
 * `Timer delay must be a number of milliseconds (got NaN)` instead.
 */

import { afterEach, expect, test } from 'bun:test';
import { resetClock, setClock, simulatedClock } from '../src/client/workflow/clock';
import { executeSubWorkflow } from '../src/client/workflow/subWorkflowRunner';
import type { Execution } from '../src/client/workflow/types';

afterEach(() => resetClock());

test('a child with a NaN start time fails the node with an error that names it', async () => {
  setClock(simulatedClock(3));
  const child = { id: 'child-1', state: 'running', createdAt: NaN, steps: {} };
  let reads = 0;
  const run = executeSubWorkflow(
    'child-wf',
    {},
    () => Promise.resolve({ id: 'child-1' }),
    () => {
      reads++;
      return child as unknown as Execution;
    },
    { existingChildId: 'child-1', assertActive: () => {}, pollIntervalMs: 10, maxWaitMs: 1_000 }
  );

  await expect(run).rejects.toThrow(
    'Sub-workflow "child-wf" (child-1) has an invalid start time (NaN)'
  );
  expect(reads).toBeLessThanOrEqual(2);
});
