/**
 * Workflow Engine - Tests for new features:
 * 5. Observability (events)
 */

import { describe, test, expect, afterEach, setDefaultTimeout } from 'bun:test';
import { Workflow, Engine } from '../src/client/workflow';
import type { WorkflowEvent, StepEvent } from '../src/client/workflow';
import { waitForWorkflowState } from './workflowTestUtils';
import { waitUntil } from './support/workflow-wait-until';

setDefaultTimeout(30_000);

describe('Workflow Engine - Observability', () => {
  let engine: Engine;
  afterEach(async () => {
    if (engine) await engine.close(true);
  });

  test('emits step and workflow lifecycle events', async () => {
    const events: WorkflowEvent[] = [];

    const flow = new Workflow('events-test')
      .step('a', async () => ({ x: 1 }))
      .step('b', async () => ({ y: 2 }));

    engine = new Engine({ embedded: true });
    engine.onAny((e) => events.push(e));
    engine.register(flow);

    const run = await engine.start('events-test');
    await waitUntil(() => events.some((e) => e.type === 'workflow:completed'));

    const types = events.map((e) => e.type);
    expect(types).toContain('workflow:started');
    expect(types).toContain('step:started');
    expect(types).toContain('step:completed');
    expect(types).toContain('workflow:completed');

    // All events reference our execution
    expect(events.every((e) => e.executionId === run.id)).toBe(true);
  });

  test('emits step:retry events on retry', async () => {
    let attempts = 0;
    const retryEvents: StepEvent[] = [];

    const flow = new Workflow('retry-events').step(
      'flaky',
      async () => {
        attempts++;
        if (attempts < 3) throw new Error('fail');
        return { ok: true };
      },
      { retry: 3 }
    );

    engine = new Engine({ embedded: true });
    engine.on('step:retry', (e) => retryEvents.push(e as StepEvent));
    engine.register(flow);

    const run = await engine.start('retry-events');
    await waitForWorkflowState(engine, run.id, 'completed');

    expect(retryEvents.length).toBe(2); // 2 retries before success on 3rd
    expect(retryEvents[0].stepName).toBe('flaky');
    expect(retryEvents[0].attempt).toBe(1);
    expect(retryEvents[1].attempt).toBe(2);
  });

  test('emits workflow:failed and workflow:compensating on failure', async () => {
    const lifecycleTypes: string[] = [];

    const flow = new Workflow('fail-events')
      .step('setup', async () => ({ done: true }), { compensate: async () => {} })
      .step(
        'boom',
        async () => {
          throw new Error('fail');
        },
        { retry: 1 }
      );

    engine = new Engine({ embedded: true });
    engine.on('workflow:failed', () => lifecycleTypes.push('failed'));
    engine.on('workflow:compensating', () => lifecycleTypes.push('compensating'));
    engine.register(flow);

    await engine.start('fail-events');
    await waitUntil(
      () => lifecycleTypes.includes('failed') && lifecycleTypes.includes('compensating')
    );

    expect(lifecycleTypes).toContain('failed');
    expect(lifecycleTypes).toContain('compensating');
  });

  test('onEvent constructor option works', async () => {
    const events: string[] = [];

    const flow = new Workflow('onevent-test').step('a', async () => ({ ok: true }));

    engine = new Engine({
      embedded: true,
      onEvent: (e) => events.push(e.type),
    });
    engine.register(flow);

    await engine.start('onevent-test');
    await waitUntil(() => events.includes('workflow:completed'));

    expect(events).toContain('workflow:started');
    expect(events).toContain('workflow:completed');
  });

  test('off removes a listener', async () => {
    const events: string[] = [];
    const listener = (e: WorkflowEvent) => events.push(e.type);

    const flow = new Workflow('off-test').step('a', async () => ({ ok: true }));

    engine = new Engine({ embedded: true });
    engine.on('step:completed', listener);
    engine.off('step:completed', listener);
    engine.register(flow);

    const run = await engine.start('off-test');
    // step:completed is emitted before the run completes, so this wait covers it.
    await waitForWorkflowState(engine, run.id, 'completed');

    expect(events.filter((t) => t === 'step:completed').length).toBe(0);
  });
});
