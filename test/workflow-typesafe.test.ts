import { describe, test, expect, afterEach } from 'bun:test';
import { Workflow, Engine } from '../src/client/workflow';

let engine: Engine;

afterEach(async () => {
  try {
    await engine?.close(true);
  } catch {}
});

function waitForState(eng: Engine, id: string, target: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const exec = eng.getExecution(id);
      if (exec?.state === target) return resolve();
      if (Date.now() - start > timeoutMs)
        return reject(new Error(`Timeout waiting for state "${target}"`));
      setTimeout(check, 50);
    };
    check();
  });
}

describe('type-safe workflow steps', () => {
  test('step return types are inferred and accessible without cast', async () => {
    // This test verifies that ctx.steps has properly typed access
    // to previously completed step results
    const flow = new Workflow<{ orderId: string }>('typed-chain')
      .step('validate', async (ctx) => {
        return { orderId: ctx.input.orderId, valid: true };
      })
      .step('charge', async (ctx) => {
        // ctx.steps.validate should be typed as { orderId: string, valid: boolean }
        const v = ctx.steps.validate;
        return { txId: `tx_${v.orderId}`, amount: 100 };
      })
      .step('confirm', async (ctx) => {
        const charge = ctx.steps.charge;
        return { confirmed: true, txId: charge.txId };
      });

    engine = new Engine({ embedded: true });
    engine.register(flow);
    const run = await engine.start('typed-chain', { orderId: 'ORD-1' });
    await waitForState(engine, run.id, 'completed');

    const exec = engine.getExecution(run.id);
    expect(exec?.state).toBe('completed');
    expect((exec?.steps['confirm']?.result as { confirmed: boolean }).confirmed).toBe(true);
    expect((exec?.steps['confirm']?.result as { txId: string }).txId).toBe('tx_ORD-1');
  });

  test('input type is properly threaded through steps', async () => {
    const flow = new Workflow<{ name: string; age: number }>('typed-input').step(
      'greet',
      async (ctx) => {
        // ctx.input should be typed as { name: string; age: number }
        return { greeting: `Hello ${ctx.input.name}, age ${ctx.input.age}` };
      }
    );

    engine = new Engine({ embedded: true });
    engine.register(flow);
    const run = await engine.start('typed-input', { name: 'Alice', age: 30 });
    await waitForState(engine, run.id, 'completed');

    const exec = engine.getExecution(run.id);
    expect((exec?.steps['greet']?.result as { greeting: string }).greeting).toBe(
      'Hello Alice, age 30'
    );
  });

  test('parallel steps accumulate types', async () => {
    const flow = new Workflow<{ userId: string }>('typed-parallel')
      .parallel((w) =>
        w
          .step('fetch-profile', async () => ({ name: 'Alice' }))
          .step('fetch-orders', async () => ({ count: 5 }))
      )
      .step('merge', async (ctx) => {
        const profile = ctx.steps['fetch-profile'];
        const orders = ctx.steps['fetch-orders'];
        return { name: profile.name, orderCount: orders.count };
      });

    engine = new Engine({ embedded: true });
    engine.register(flow);
    const run = await engine.start('typed-parallel', { userId: 'u1' });
    await waitForState(engine, run.id, 'completed');

    const exec = engine.getExecution(run.id);
    const result = exec?.steps['merge']?.result as { name: string; orderCount: number };
    expect(result.name).toBe('Alice');
    expect(result.orderCount).toBe(5);
  });

  test('map step result is typed in subsequent steps', async () => {
    const flow = new Workflow<{ items: number[] }>('typed-map')
      .step('load', async (ctx) => {
        return { items: ctx.input.items };
      })
      .map('summary', (ctx) => {
        const { items } = ctx.steps.load;
        return { total: items.reduce((s: number, n: number) => s + n, 0), count: items.length };
      })
      .step('report', async (ctx) => {
        const s = ctx.steps.summary;
        return { message: `Total: ${s.total}, Count: ${s.count}` };
      });

    engine = new Engine({ embedded: true });
    engine.register(flow);
    const run = await engine.start('typed-map', { items: [1, 2, 3] });
    await waitForState(engine, run.id, 'completed');

    const exec = engine.getExecution(run.id);
    const result = exec?.steps['report']?.result as { message: string };
    expect(result.message).toBe('Total: 6, Count: 3');
  });

  test('subWorkflow result is typed under sub: prefix', async () => {
    const childFlow = new Workflow<{ amount: number }>('payment').step('charge', async (ctx) => {
      return { txId: `tx_${ctx.input.amount}` };
    });

    const parentFlow = new Workflow<{ amount: number }>('order')
      .step('init', async (ctx) => ({ orderId: 'O1', amount: ctx.input.amount }))
      .subWorkflow('payment', (ctx) => ({
        amount: ctx.steps.init.amount,
      }))
      .step('done', async (ctx) => {
        const payment = ctx.steps['sub:payment'];
        return { completed: true, payment };
      });

    engine = new Engine({ embedded: true });
    engine.register(childFlow);
    engine.register(parentFlow);
    const run = await engine.start('order', { amount: 99 });
    await waitForState(engine, run.id, 'completed');

    const exec = engine.getExecution(run.id);
    expect(exec?.state).toBe('completed');
  });

  test('backward compatibility: untyped workflow still works', async () => {
    // No generics, uses `as` casts — should work the same as before
    const flow = new Workflow('untyped')
      .step('a', async (_ctx) => {
        return { value: 42 };
      })
      .step('b', async (ctx) => {
        const a = ctx.steps['a'] as { value: number };
        return { doubled: a.value * 2 };
      });

    engine = new Engine({ embedded: true });
    engine.register(flow);
    const run = await engine.start('untyped', {});
    await waitForState(engine, run.id, 'completed');

    const exec = engine.getExecution(run.id);
    expect((exec?.steps['b']?.result as { doubled: number }).doubled).toBe(84);
  });

  test('forEach step types are accessible', async () => {
    const flow = new Workflow<{ items: string[] }>('typed-foreach')
      .forEach(
        (ctx) => ctx.input.items,
        'process',
        async (ctx) => {
          const item = ctx.steps.__item as string;
          return { processed: item.toUpperCase() };
        }
      )
      .step('done', async () => ({ complete: true }));

    engine = new Engine({ embedded: true });
    engine.register(flow);
    const run = await engine.start('typed-foreach', { items: ['a', 'b'] });
    await waitForState(engine, run.id, 'completed');

    const exec = engine.getExecution(run.id);
    expect(exec?.state).toBe('completed');
    expect((exec?.steps['process:0']?.result as { processed: string }).processed).toBe('A');
    expect((exec?.steps['process:1']?.result as { processed: string }).processed).toBe('B');
  });

  test('compensate handler has access to typed steps', async () => {
    let compensateCtx: unknown;
    const flow = new Workflow<{ id: string }>('typed-compensate')
      .step('create', async (ctx) => ({ resourceId: `res_${ctx.input.id}` }), {
        compensate: async (ctx) => {
          // ctx.steps should be available with proper typing
          compensateCtx = ctx.steps;
        },
      })
      .step('fail', async () => {
        throw new Error('boom');
      });

    engine = new Engine({ embedded: true });
    engine.register(flow);
    const run = await engine.start('typed-compensate', { id: '123' });
    await waitForState(engine, run.id, 'failed', 5000);

    expect(compensateCtx).toBeDefined();
    expect((compensateCtx as Record<string, unknown>)['create']).toEqual({
      resourceId: 'res_123',
    });
  });
});
