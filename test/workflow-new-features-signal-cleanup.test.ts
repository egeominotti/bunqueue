/**
 * Workflow Engine - Tests for new features:
 * 3. Signal timeout
 * 4. Cleanup / archival
 */

import { describe, test, expect, afterEach, setDefaultTimeout } from 'bun:test';
import { Workflow, Engine } from '../src/client/workflow';
import { waitForWorkflowState } from './workflowTestUtils';
import { waitUntil } from './support/workflow-wait-until';

setDefaultTimeout(30_000);

describe('Workflow Engine - Signal Timeout', () => {
  let engine: Engine;
  afterEach(async () => {
    if (engine) await engine.close(true);
  });

  test('signal timeout fails the workflow when no signal arrives', async () => {
    const compensations: string[] = [];

    const flow = new Workflow('timeout-signal')
      .step('submit', async () => ({ submitted: true }), {
        compensate: async () => {
          compensations.push('undo-submit');
        },
      })
      .waitFor('approval', { timeout: 1000 });

    engine = new Engine({ embedded: true });
    engine.register(flow);

    const run = await engine.start('timeout-signal');
    // Wait for step to complete + delayed job to fire after timeout
    await waitForWorkflowState(engine, run.id, 'failed');

    const exec = engine.getExecution(run.id);
    expect(exec!.state).toBe('failed');
    // The waitFor synthetic step should show the timeout error
    expect(exec!.steps['__waitFor:approval']?.error).toContain('timed out');
    // Compensation should have run for completed steps
    expect(compensations).toContain('undo-submit');
  });

  test('signal arriving before timeout succeeds normally', async () => {
    const flow = new Workflow('signal-ok')
      .step('submit', async () => ({ submitted: true }))
      .waitFor('approval', { timeout: 10_000 })
      .step('process', async (ctx) => {
        return { decision: ctx.signals['approval'] };
      });

    engine = new Engine({ embedded: true });
    engine.register(flow);

    const run = await engine.start('signal-ok');
    await waitForWorkflowState(engine, run.id, 'waiting');

    expect(engine.getExecution(run.id)!.state).toBe('waiting');

    await engine.signal(run.id, 'approval', { approved: true });
    await waitForWorkflowState(engine, run.id, 'completed');

    const exec = engine.getExecution(run.id);
    expect(exec!.state).toBe('completed');
    expect((exec!.steps['process'].result as { decision: unknown }).decision).toEqual({
      approved: true,
    });
  });
});

describe('Workflow Engine - Cleanup & Archival', () => {
  let engine: Engine;
  afterEach(async () => {
    if (engine) await engine.close(true);
  });

  test('cleanup removes old completed executions', async () => {
    const flow = new Workflow('cleanup-test').step('do', async () => ({ done: true }));

    engine = new Engine({ embedded: true });
    engine.register(flow);

    await engine.start('cleanup-test');
    await engine.start('cleanup-test');
    await engine.start('cleanup-test');
    await waitUntil(() => {
      const runs = engine.listExecutions('cleanup-test');
      return runs.length === 3 && runs.every((e) => e.state === 'completed');
    });

    const before = engine.listExecutions('cleanup-test');
    expect(before.length).toBe(3);
    expect(before.every((e) => e.state === 'completed')).toBe(true);

    // Cleanup with maxAge=0 removes everything completed
    const removed = engine.cleanup(0);
    expect(removed).toBe(3);

    const after = engine.listExecutions('cleanup-test');
    expect(after.length).toBe(0);
  });

  test('cleanup only removes specified states', async () => {
    const flow = new Workflow('cleanup-states').step('do', async () => ({ done: true }));

    engine = new Engine({ embedded: true });
    engine.register(flow);

    const run = await engine.start('cleanup-states');
    await waitForWorkflowState(engine, run.id, 'completed');

    // Only remove 'failed' — our completed execution should survive
    const removed = engine.cleanup(0, ['failed']);
    expect(removed).toBe(0);

    const remaining = engine.listExecutions('cleanup-states');
    expect(remaining.length).toBe(1);
  });

  test('archive moves executions to archive table', async () => {
    const flow = new Workflow('archive-test').step('do', async () => ({ done: true }));

    engine = new Engine({ embedded: true });
    engine.register(flow);

    await engine.start('archive-test');
    await engine.start('archive-test');
    await waitUntil(() => {
      const runs = engine.listExecutions('archive-test');
      return runs.length === 2 && runs.every((e) => e.state === 'completed');
    });

    expect(engine.listExecutions('archive-test').length).toBe(2);

    const archived = engine.archive(0);
    expect(archived).toBe(2);

    // Main table should be empty
    expect(engine.listExecutions('archive-test').length).toBe(0);

    // Archive table should have them
    expect(engine.getArchivedCount()).toBe(2);
  });
});
