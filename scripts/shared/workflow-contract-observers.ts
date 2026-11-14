import { Workflow } from '../../src/client/workflow';
import type { WorkflowEventListener } from '../../src/client/workflow/types';
import { check, until, type Scenario } from './workflow-contract-support';

export const archive: Scenario = {
  title: 'Cleanup / archival',
  async run(c) {
    const flow = new Workflow(c.name('cleanup')).step('do', async () => ({ done: true }));
    const engine = c.engine().register(flow);
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await engine.start(c.name('cleanup')));
    await Promise.all(runs.map((run) => c.state(engine, run.id, 'completed')));
    check(engine.listExecutions(c.name('cleanup')).length === 3, 'Cleanup expected 3 executions');
    const archived = engine.archive(0);
    check(archived === 3, `Cleanup archived=${archived}, expected 3`);
    check(engine.listExecutions(c.name('cleanup')).length === 0, 'Cleanup executions not moved');
    check(engine.getArchivedCount() === 3, 'Cleanup archive count wrong');
  },
};

export const observability: Scenario = {
  title: 'Observability (events)',
  async run(c) {
    const events: string[] = [];
    const flow = new Workflow(c.name('events'))
      .step('a', async () => ({ x: 1 }))
      .step('b', async () => ({ y: 2 }));
    const engine = c.engine();
    const listener: WorkflowEventListener = (event) => {
      events.push(event.type);
    };
    engine.onAny(listener);
    c.defer(() => {
      engine.offAny(listener);
    });
    engine.register(flow);
    const run = await engine.start(c.name('events'));
    const required = ['workflow:started', 'step:started', 'step:completed', 'workflow:completed'];
    await until(`lifecycle events ${required.join(',')}`, () =>
      required.every((type) => events.includes(type))
    );
    await c.state(engine, run.id, 'completed');
    for (const type of required) check(events.includes(type), `Observability missing ${type}`);
  },
};

export const subscribe: Scenario = {
  title: 'Subscribe to execution events',
  async run(c) {
    const events: string[] = [];
    const first = c.gate();
    let firstStarted = false;
    const flow = new Workflow(c.name('sub'))
      .step(
        'a',
        async () => {
          firstStarted = true;
          await first.wait;
          return { ok: true };
        },
        { retry: 1 }
      )
      .step('b', async () => ({ ok: true }), { retry: 1 });
    const engine = c.engine().register(flow);
    const run = await engine.start(c.name('sub'));
    // Deliberately let the first handler start before subscribing; it cannot finish.
    await until('subscription first step to reach its gate', () => firstStarted);
    check(
      engine.getExecution(run.id)?.steps['a']?.status === 'running',
      'Subscribe first step escaped gate'
    );
    const unsub = engine.subscribe(run.id, (event) => {
      events.push(event.type);
    });
    c.defer(unsub);
    first.release();
    const required = ['step:started', 'step:completed', 'workflow:completed'];
    await until(`subscription events ${required.join(',')}`, () =>
      required.every((type) => events.includes(type))
    );
    await c.state(engine, run.id, 'completed');
    for (const type of required) check(events.includes(type), `Subscribe missing ${type}`);
  },
};
