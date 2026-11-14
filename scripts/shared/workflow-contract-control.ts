import { Workflow } from '../../src/client/workflow';
import { check, until, type Scenario } from './workflow-contract-support';

export const signal: Scenario = {
  title: 'WaitFor + Signal (human-in-the-loop)',
  async run(c) {
    const log: string[] = [];
    const flow = new Workflow(c.name('signal'))
      .step('submit', async () => {
        log.push('submit');
        return { ok: true };
      })
      .waitFor('approval')
      .step('process', async (ctx) => {
        const data = ctx.signals['approval'] as { approved: boolean };
        log.push(data.approved ? 'approved' : 'rejected');
        return { done: true };
      });
    const engine = c.engine().register(flow);
    const run = await engine.start(c.name('signal'));
    await c.state(engine, run.id, 'waiting');
    await engine.signal(run.id, 'approval', { approved: true });
    await c.state(engine, run.id, 'completed');
    check(log.join(',') === 'submit,approved', `Signal log=${log}`);
  },
};

export const concurrent: Scenario = {
  title: 'Concurrent executions (5 parallel runs)',
  async run(c) {
    const gate = c.gate();
    let started = 0;
    const flow = new Workflow(c.name('concurrent')).step('compute', async (ctx) => {
      started++;
      await gate.wait;
      return { result: (ctx.input as { n: number }).n * 2 };
    });
    const engine = c.engine(10).register(flow);
    const runs = await Promise.all(
      Array.from({ length: 5 }, (_, n) => engine.start(c.name('concurrent'), { n }))
    );
    await until('all five execution handlers to start before release', () => started === 5);
    gate.release();
    const expected = [0, 2, 4, 6, 8];
    for (const [n, run] of runs.entries()) {
      const exec = await c.state(engine, run.id, 'completed');
      check(
        (exec.steps['compute'].result as { result: number }).result === expected[n],
        `Concurrent result wrong for input ${n}`
      );
    }
  },
};

export const parallel: Scenario = {
  title: 'Parallel steps',
  async run(c) {
    const gate = c.gate();
    const started: string[] = [];
    const finished: string[] = [];
    const task = async (key: string) => {
      started.push(key);
      await gate.wait;
      finished.push(key);
      return { [key]: true };
    };
    const flow = new Workflow(c.name('parallel'))
      .step('init', async () => ({ ready: true }))
      .parallel((w) =>
        w
          .step('task-a', async () => task('a'))
          .step('task-b', async () => task('b'))
          .step('task-c', async () => task('c'))
      )
      .step('done', async () => ({ complete: true }));
    const engine = c.engine().register(flow);
    const run = await engine.start(c.name('parallel'));
    await until(
      'all three parallel handlers to start before any completes',
      () => started.length === 3
    );
    check(finished.length === 0, `Parallel finished before barrier release: ${finished}`);
    gate.release();
    const exec = await c.state(engine, run.id, 'completed');
    for (const key of ['a', 'b', 'c']) {
      check(
        exec.steps[`task-${key}`]?.status === 'completed',
        `Parallel task-${key} not completed`
      );
      check(
        (exec.steps[`task-${key}`].result as Record<string, boolean>)[key] === true,
        `Parallel task-${key} result wrong`
      );
    }
    check(exec.steps['done']?.status === 'completed', 'Parallel done step not completed');
    check(
      (exec.steps['done'].result as { complete: boolean }).complete,
      'Parallel done result wrong'
    );
  },
};
