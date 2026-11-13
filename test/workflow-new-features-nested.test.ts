/**
 * Workflow Engine - Tests for new features:
 * 6. Nested workflows (sub-workflow)
 * plus the combined retry + parallel + compensation pipeline
 */

import { describe, test, expect, afterEach, setDefaultTimeout } from 'bun:test';
import { Workflow, Engine } from '../src/client/workflow';
import { waitForWorkflowState } from './workflowTestUtils';
import { waitUntil } from './support/workflow-wait-until';

setDefaultTimeout(30_000);

describe('Workflow Engine - Nested Workflows', () => {
  let engine: Engine;
  afterEach(async () => {
    if (engine) await engine.close(true);
  });

  test('sub-workflow executes child and passes results to parent', async () => {
    const child = new Workflow('payment')
      .step('validate', async (ctx) => {
        const input = ctx.input as { amount: number };
        return { valid: input.amount > 0 };
      })
      .step('charge', async (ctx) => {
        const input = ctx.input as { amount: number };
        return { txId: `tx_${input.amount}` };
      });

    const parent = new Workflow('order')
      .step('create-order', async () => {
        return { orderId: 'ORD-1', total: 99.99 };
      })
      .subWorkflow('payment', (ctx) => ({
        amount: (ctx.steps['create-order'] as { total: number }).total,
      }))
      .step('confirm', async (ctx) => {
        const paymentResult = ctx.steps['sub:payment'] as Record<string, unknown>;
        return { confirmed: true, payment: paymentResult };
      });

    engine = new Engine({ embedded: true });
    engine.register(child);
    engine.register(parent);

    const run = await engine.start('order');
    await waitForWorkflowState(engine, run.id, 'completed', 10_000);

    const exec = engine.getExecution(run.id);
    expect(exec!.state).toBe('completed');
    expect(exec!.steps['create-order'].status).toBe('completed');
    expect(exec!.steps['sub:payment'].status).toBe('completed');
    expect(exec!.steps['confirm'].status).toBe('completed');

    // Sub-workflow results should be available
    const subResult = exec!.steps['sub:payment'].result as Record<string, unknown>;
    expect(subResult['validate']).toEqual({ valid: true });
    expect(subResult['charge']).toEqual({ txId: 'tx_99.99' });
  });

  test('sub-workflow failure fails the parent', async () => {
    const compensations: string[] = [];

    const child = new Workflow('bad-child').step(
      'fail',
      async () => {
        throw new Error('child failed');
      },
      { retry: 1 }
    );

    const parent = new Workflow('parent-with-bad-child')
      .step('setup', async () => ({ ready: true }), {
        // Resolves to push()'s count, not void; the value is never asserted.
        compensate: (async () =>
          compensations.push('undo-setup')) as unknown as () => Promise<void>,
      })
      .subWorkflow('bad-child', () => ({}));

    engine = new Engine({ embedded: true });
    engine.register(child);
    engine.register(parent);

    const run = await engine.start('parent-with-bad-child');
    // 'failed' is written before the rollback runs; wait for the rollback to settle too.
    await waitUntil(() => {
      const exec = engine.getExecution(run.id);
      return exec?.state === 'failed' && exec.rollbackStatus !== undefined;
    }, 10_000);

    const exec = engine.getExecution(run.id);
    expect(exec!.state).toBe('failed');
    expect(compensations).toContain('undo-setup');
  });
});

describe('Workflow Engine - Combined Features', () => {
  let engine: Engine;
  afterEach(async () => {
    if (engine) await engine.close(true);
  });

  test('e-commerce pipeline: retry + parallel + compensation', async () => {
    let chargeAttempts = 0;
    const compensations: string[] = [];
    const notifications: string[] = [];

    const flow = new Workflow('ecommerce')
      .step(
        'create-order',
        async () => {
          return { orderId: 'ORD-777' };
        },
        {
          // Resolves to push()'s count, not void; the value is never asserted.
          compensate: (async () =>
            compensations.push('cancel-order')) as unknown as () => Promise<void>,
        }
      )
      .step(
        'charge-payment',
        async () => {
          chargeAttempts++;
          if (chargeAttempts < 2) throw new Error('gateway timeout');
          return { txId: 'tx_abc' };
        },
        {
          retry: 3,
          // Resolves to push()'s count, not void; the value is never asserted.
          compensate: (async () => compensations.push('refund')) as unknown as () => Promise<void>,
        }
      )
      .parallel((w) =>
        w
          .step('send-email', async () => {
            notifications.push('email');
            return { email: true };
          })
          .step('send-sms', async () => {
            notifications.push('sms');
            return { sms: true };
          })
      )
      .step('finalize', async () => {
        return { complete: true };
      });

    engine = new Engine({ embedded: true });
    engine.register(flow);

    const run = await engine.start('ecommerce');
    await waitForWorkflowState(engine, run.id, 'completed', 10_000);

    const exec = engine.getExecution(run.id);
    expect(exec!.state).toBe('completed');
    expect(chargeAttempts).toBe(2); // Failed once, succeeded on retry
    expect(notifications).toContain('email');
    expect(notifications).toContain('sms');
    expect(compensations.length).toBe(0); // No compensation needed
  });
});
