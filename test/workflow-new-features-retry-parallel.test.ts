/**
 * Workflow Engine - Tests for new features:
 * 1. Step retry with backoff
 * 2. Parallel steps
 */

import { describe, test, expect, afterEach, setDefaultTimeout } from 'bun:test';
import { Workflow, Engine } from '../src/client/workflow';
import { waitForWorkflowState } from './workflowTestUtils';

setDefaultTimeout(30_000);

describe('Workflow Engine - Step Retry', () => {
  let engine: Engine;
  afterEach(async () => {
    if (engine) await engine.close(true);
  });

  test('retries a failing step before giving up', async () => {
    let attempts = 0;

    const flow = new Workflow('retry-test').step(
      'flaky',
      async () => {
        attempts++;
        if (attempts < 3) throw new Error(`fail #${attempts}`);
        return { ok: true };
      },
      { retry: 3 }
    );

    engine = new Engine({ embedded: true });
    engine.register(flow);

    const run = await engine.start('retry-test');
    const exec = await waitForWorkflowState(engine, run.id, 'completed');
    expect(exec!.state).toBe('completed');
    expect(attempts).toBe(3);
    expect(exec!.steps['flaky'].status).toBe('completed');
    expect(exec!.steps['flaky'].attempts).toBe(3);
  });

  test('fails after exhausting all retries', async () => {
    let attempts = 0;

    const flow = new Workflow('retry-exhaust').step(
      'always-fail',
      async () => {
        attempts++;
        throw new Error('nope');
      },
      { retry: 2 }
    );

    engine = new Engine({ embedded: true });
    engine.register(flow);

    const run = await engine.start('retry-exhaust');
    const exec = await waitForWorkflowState(engine, run.id, 'failed');
    expect(exec!.state).toBe('failed');
    expect(attempts).toBe(2);
    expect(exec!.steps['always-fail'].status).toBe('failed');
    expect(exec!.steps['always-fail'].attempts).toBe(2);
  });

  test('retry: 1 means no retry (fail immediately)', async () => {
    let attempts = 0;

    const flow = new Workflow('no-retry').step(
      'once',
      async () => {
        attempts++;
        throw new Error('boom');
      },
      { retry: 1 }
    );

    engine = new Engine({ embedded: true });
    engine.register(flow);

    const run = await engine.start('no-retry');
    const exec = await waitForWorkflowState(engine, run.id, 'failed');
    expect(exec!.state).toBe('failed');
    expect(attempts).toBe(1);
  });

  test('retry + compensation: compensation runs once after all retries exhausted', async () => {
    let attempts = 0;
    const compensations: string[] = [];

    const flow = new Workflow('retry-compensate')
      .step(
        'setup',
        async () => {
          return { done: true };
        },
        {
          compensate: async () => {
            compensations.push('undo-setup');
          },
        }
      )
      .step(
        'flaky',
        async () => {
          attempts++;
          throw new Error('always fails');
        },
        { retry: 2 }
      );

    engine = new Engine({ embedded: true });
    engine.register(flow);

    const run = await engine.start('retry-compensate');
    const exec = await waitForWorkflowState(engine, run.id, 'failed');
    expect(exec!.state).toBe('failed');
    expect(attempts).toBe(2);
    expect(compensations).toEqual(['undo-setup']);
  });
});

describe('Workflow Engine - Parallel Steps', () => {
  let engine: Engine;
  afterEach(async () => {
    if (engine) await engine.close(true);
  });

  test('runs steps in parallel and collects results', async () => {
    const order: string[] = [];
    const startTimes: Record<string, number> = {};

    const flow = new Workflow('parallel-test')
      .step('init', async () => {
        return { ready: true };
      })
      .parallel((w) =>
        w
          .step('email', async () => {
            startTimes['email'] = Date.now();
            order.push('email-start');
            await new Promise((r) => setTimeout(r, 200));
            order.push('email-end');
            return { sent: true };
          })
          .step('sms', async () => {
            startTimes['sms'] = Date.now();
            order.push('sms-start');
            await new Promise((r) => setTimeout(r, 100));
            order.push('sms-end');
            return { sent: true };
          })
          .step('webhook', async () => {
            startTimes['webhook'] = Date.now();
            order.push('webhook-start');
            await new Promise((r) => setTimeout(r, 150));
            order.push('webhook-end');
            return { delivered: true };
          })
      )
      .step('finalize', async () => {
        return { done: true };
      });

    engine = new Engine({ embedded: true });
    engine.register(flow);

    const run = await engine.start('parallel-test');
    await waitForWorkflowState(engine, run.id, 'completed');

    const exec = engine.getExecution(run.id);
    expect(exec!.state).toBe('completed');
    expect(exec!.steps['email'].status).toBe('completed');
    expect(exec!.steps['sms'].status).toBe('completed');
    expect(exec!.steps['webhook'].status).toBe('completed');
    expect(exec!.steps['finalize'].status).toBe('completed');

    // All parallel steps should have started before any ended
    // (proves they ran concurrently, not sequentially)
    const starts = order.filter((o) => o.endsWith('-start'));
    const firstEnd = order.findIndex((o) => o.endsWith('-end'));
    expect(starts.length).toBe(3);
    expect(firstEnd).toBeGreaterThanOrEqual(3); // All 3 starts before any end

    // Start times should be very close (within 50ms)
    const times = Object.values(startTimes);
    const spread = Math.max(...times) - Math.min(...times);
    expect(spread).toBeLessThan(50);
  });

  test('parallel step failure triggers compensation of prior steps', async () => {
    const compensations: string[] = [];

    const flow = new Workflow('parallel-fail')
      .step('setup', async () => ({ ready: true }), {
        compensate: async () => {
          compensations.push('undo-setup');
        },
      })
      .parallel((w) =>
        w
          .step('ok-step', async () => {
            await new Promise((r) => setTimeout(r, 50));
            return { ok: true };
          })
          .step(
            'bad-step',
            async () => {
              throw new Error('parallel failure');
            },
            { retry: 1 }
          )
      );

    engine = new Engine({ embedded: true });
    engine.register(flow);

    const run = await engine.start('parallel-fail');
    await waitForWorkflowState(engine, run.id, 'failed');

    const exec = engine.getExecution(run.id);
    expect(exec!.state).toBe('failed');
    expect(compensations).toContain('undo-setup');
  });

  test('parallel() with empty builder throws', () => {
    expect(() => {
      new Workflow('empty-parallel').parallel((w) => w);
    }).toThrow('parallel() requires at least one step');
  });
});
