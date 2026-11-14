import { Workflow } from '../../src/client/workflow';
import { check, type Scenario } from './workflow-contract-support';

export const compensation: Scenario = {
  title: 'Compensation (saga rollback on failure)',
  async run(c) {
    const log: string[] = [];
    const flow = new Workflow(c.name('compensate'))
      .step(
        'create',
        async () => {
          log.push('create');
          return { id: 1 };
        },
        {
          compensate: async () => {
            log.push('undo-create');
          },
        }
      )
      .step(
        'charge',
        async () => {
          log.push('charge');
          return { txId: 'abc' };
        },
        {
          compensate: async () => {
            log.push('refund');
          },
        }
      )
      .step(
        'explode',
        async () => {
          throw new Error('Boom');
        },
        { retry: 1 }
      );
    const engine = c.engine().register(flow);
    const run = await engine.start(c.name('compensate'));
    await c.state(engine, run.id, 'failed');
    check(log.includes('refund') && log.includes('undo-create'), `Missing rollback: ${log}`);
    check(log.indexOf('refund') < log.indexOf('undo-create'), `Wrong compensation order: ${log}`);
  },
};

export const stepTimeout: Scenario = {
  title: 'Step timeout',
  async run(c) {
    // The handler stays pending until teardown; the real 200ms engine timeout must win.
    const gate = c.gate();
    const flow = new Workflow(c.name('timeout')).step(
      'slow',
      async () => {
        await gate.wait;
        return { done: true };
      },
      { timeout: 200, retry: 1 }
    );
    const engine = c.engine().register(flow);
    const run = await engine.start(c.name('timeout'));
    const exec = await c.state(engine, run.id, 'failed');
    check(
      exec.steps['slow'].error?.includes('timed out'),
      `Step timeout error=${exec.steps['slow'].error}`
    );
  },
};

export const retry: Scenario = {
  title: 'Step retry with backoff',
  async run(c) {
    let attempts = 0;
    const flow = new Workflow(c.name('retry')).step(
      'flaky',
      async () => {
        attempts++;
        if (attempts < 3) throw new Error(`fail #${attempts}`);
        return { ok: true };
      },
      { retry: 3 }
    );
    const engine = c.engine().register(flow);
    const run = await engine.start(c.name('retry'));
    const exec = await c.state(engine, run.id, 'completed');
    check(attempts === 3, `Retry attempts=${attempts}, expected 3`);
    check(
      exec.steps['flaky'].attempts === 3,
      `Retry recorded attempts=${exec.steps['flaky'].attempts}`
    );
  },
};

export const signalTimeout: Scenario = {
  title: 'Signal timeout',
  async run(c) {
    const compensations: string[] = [];
    const flow = new Workflow(c.name('sig-timeout'))
      .step('submit', async () => ({ ok: true }), {
        compensate: async () => {
          compensations.push('undo-submit');
        },
      })
      .waitFor('approval', { timeout: 1000 });
    const engine = c.engine().register(flow);
    const run = await engine.start(c.name('sig-timeout'));
    const exec = await c.state(engine, run.id, 'failed');
    check(
      exec.steps['__waitFor:approval']?.error?.includes('timed out'),
      `Signal timeout error=${exec.steps['__waitFor:approval']?.error}`
    );
    check(compensations.includes('undo-submit'), 'Signal timeout compensation not run');
  },
};
