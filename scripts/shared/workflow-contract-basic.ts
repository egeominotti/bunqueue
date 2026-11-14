import { Workflow } from '../../src/client/workflow';
import { check, type Scenario } from './workflow-contract-support';

export const linear: Scenario = {
  title: 'Linear workflow (3 steps with context passing)',
  async run(c) {
    const log: string[] = [];
    const flow = new Workflow(c.name('linear'))
      .step('a', async () => {
        log.push('a');
        return { x: 1 };
      })
      .step('b', async (ctx) => {
        log.push('b');
        return { x: (ctx.steps['a'] as { x: number }).x + 1 };
      })
      .step('c', async (ctx) => {
        log.push('c');
        return { total: (ctx.steps['b'] as { x: number }).x + 1 };
      });
    const engine = c.engine().register(flow);
    const run = await engine.start(c.name('linear'), { seed: 42 });
    const exec = await c.state(engine, run.id, 'completed');
    check(log.join(',') === 'a,b,c', `Linear log=${log}`);
    check((exec.steps['c'].result as { total: number }).total === 3, 'Linear total != 3');
  },
};

export const branching: Scenario = {
  title: 'Branching workflow (VIP vs standard)',
  async run(c) {
    const log: string[] = [];
    const flow = new Workflow(c.name('branch'))
      .step('classify', async (ctx) => ({ tier: (ctx.input as { tier: string }).tier }))
      .branch((ctx) => (ctx.steps['classify'] as { tier: string }).tier)
      .path('vip', (w) =>
        w.step('vip-handler', async () => {
          log.push('vip');
          return { discount: 20 };
        })
      )
      .path('basic', (w) =>
        w.step('basic-handler', async () => {
          log.push('basic');
          return { discount: 0 };
        })
      )
      .step('done', async () => {
        log.push('done');
      });
    const engine = c.engine().register(flow);
    const run = await engine.start(c.name('branch'), { tier: 'vip' });
    await c.state(engine, run.id, 'completed');
    check(log.includes('vip') && !log.includes('basic'), `Branch wrong path: ${log}`);
    check(log.includes('done'), 'Branch post-branch step not reached');
  },
};

export const ecommerce: Scenario = {
  title: 'E-commerce order flow (end-to-end)',
  async run(c) {
    const db: Record<string, unknown> = {};
    const flow = new Workflow<{ orderId: string; amount: number }>(c.name('order'))
      .step('validate', async (ctx) => {
        const input = ctx.input as { orderId: string; amount: number };
        if (input.amount <= 0) throw new Error('Invalid amount');
        return { valid: true, orderId: input.orderId };
      })
      .step(
        'reserve-stock',
        async () => {
          db['stock'] = 'reserved';
          return { reserved: true };
        },
        {
          compensate: async () => {
            db['stock'] = 'available';
          },
        }
      )
      .step(
        'charge',
        async () => {
          db['payment'] = 'charged';
          return { txId: 'tx_001' };
        },
        {
          compensate: async () => {
            db['payment'] = 'refunded';
          },
        }
      )
      .step('confirm', async (ctx) => ({
        confirmed: true,
        txId: (ctx.steps['charge'] as { txId: string }).txId,
      }));
    const engine = c.engine().register(flow);
    const run = await engine.start(c.name('order'), { orderId: 'ORD-1', amount: 99.99 });
    const exec = await c.state(engine, run.id, 'completed');
    check(db['stock'] === 'reserved' && db['payment'] === 'charged', 'E-commerce db state wrong');
    check(
      (exec.steps['confirm'].result as { txId: string }).txId === 'tx_001',
      'E-commerce txId wrong'
    );
  },
};

export const schema: Scenario = {
  title: 'Schema validation',
  async run(c) {
    const inputSchema = {
      parse(data: unknown) {
        const obj = data as Record<string, unknown>;
        if (typeof obj.email !== 'string') throw new Error('email must be string');
        return obj;
      },
    };
    const flow = new Workflow(c.name('schema')).step('validated', async (ctx) => ctx.input, {
      retry: 1,
      inputSchema,
    });
    const engine = c.engine().register(flow);
    const valid = await engine.start(c.name('schema'), { email: 'test@test.com' });
    await c.state(engine, valid.id, 'completed');
    const invalid = await engine.start(c.name('schema'), { email: 123 });
    await c.state(engine, invalid.id, 'failed');
  },
};
