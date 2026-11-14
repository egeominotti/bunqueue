import { Workflow } from '../../src/client/workflow';
import { check, type Scenario } from './workflow-contract-support';

export const nested: Scenario = {
  title: 'Nested workflows (sub-workflow)',
  async run(c) {
    const child = new Workflow(c.name('child'))
      .step('validate', async (ctx) => ({ valid: (ctx.input as { amount: number }).amount > 0 }))
      .step('process', async () => ({ txId: 'tx_nested' }));
    const childKey = `sub:${c.name('child')}`;
    const parent = new Workflow(c.name('parent'))
      .step('create', async () => ({ orderId: 'ORD-N', total: 50 }))
      .subWorkflow(c.name('child'), (ctx) => ({
        amount: (ctx.steps['create'] as { total: number }).total,
      }))
      .step('confirm', async (ctx) => ({
        confirmed: true,
        childResult: ctx.steps[childKey] as Record<string, unknown>,
      }));
    const engine = c.engine().register(child).register(parent);
    const run = await engine.start(c.name('parent'));
    const exec = await c.state(engine, run.id, 'completed');
    check(exec.steps[childKey]?.status === 'completed', 'Nested sub-workflow not completed');
    check(exec.steps['confirm']?.status === 'completed', 'Nested confirm not completed');
    const subResult = exec.steps[childKey].result as Record<string, unknown>;
    check((subResult['validate'] as { valid: boolean }).valid, 'Nested child validate wrong');
    check(
      (subResult['process'] as { txId: string }).txId === 'tx_nested',
      'Nested child result wrong'
    );
  },
};

export const doUntil: Scenario = {
  title: 'doUntil loop',
  async run(c) {
    let counter = 0;
    const flow = new Workflow(c.name('do-until')).doUntil(
      (ctx) => (ctx.steps['inc'] as { count: number })?.count >= 3,
      (w) => w.step('inc', async () => ({ count: ++counter }), { retry: 1 })
    );
    const engine = c.engine().register(flow);
    const run = await engine.start(c.name('do-until'));
    await c.state(engine, run.id, 'completed');
    check(counter === 3, `doUntil counter=${counter}`);
  },
};

export const doWhile: Scenario = {
  title: 'doWhile loop',
  async run(c) {
    let counter = 0;
    const flow = new Workflow(c.name('do-while')).doWhile(
      (ctx) => ((ctx.steps['proc'] as { value: number })?.value ?? 0) < 3,
      (w) => w.step('proc', async () => ({ value: ++counter }), { retry: 1 })
    );
    const engine = c.engine().register(flow);
    const run = await engine.start(c.name('do-while'));
    await c.state(engine, run.id, 'completed');
    check(counter === 3, `doWhile counter=${counter}`);
  },
};

export const forEach: Scenario = {
  title: 'forEach iteration',
  async run(c) {
    const processed: string[] = [];
    const flow = new Workflow<{ items: string[] }>(c.name('foreach')).forEach(
      (ctx) => (ctx.input as { items: string[] }).items,
      'handle',
      async (ctx) => {
        const item = ctx.steps.__item as string;
        processed.push(item);
        return { item };
      },
      { retry: 1 }
    );
    const engine = c.engine().register(flow);
    const run = await engine.start(c.name('foreach'), { items: ['a', 'b', 'c'] });
    const exec = await c.state(engine, run.id, 'completed');
    check(processed.length === 3, `forEach processed=${processed.length}`);
    check(
      exec.steps['handle:0'] && exec.steps['handle:1'] && exec.steps['handle:2'],
      'forEach missing indexed steps'
    );
  },
};

export const map: Scenario = {
  title: 'map transform',
  async run(c) {
    const flow = new Workflow(c.name('map'))
      .step('fetch', async () => ({ values: [1, 2, 3] }), { retry: 1 })
      .map('sum', (ctx) => ({
        total: (ctx.steps['fetch'] as { values: number[] }).values.reduce((a, b) => a + b, 0),
      }))
      .step(
        'use',
        async (ctx) => ({
          doubled: (ctx.steps['sum'] as { total: number }).total * 2,
        }),
        { retry: 1 }
      );
    const engine = c.engine().register(flow);
    const run = await engine.start(c.name('map'));
    const exec = await c.state(engine, run.id, 'completed');
    check((exec.steps['sum']?.result as { total: number })?.total === 6, 'map wrong sum');
    check((exec.steps['use']?.result as { doubled: number })?.doubled === 12, 'map wrong doubled');
  },
};
