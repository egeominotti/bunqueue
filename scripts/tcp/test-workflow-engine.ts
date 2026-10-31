#!/usr/bin/env bun
/**
 * Test Workflow Engine (TCP Mode)
 * Tests: linear flow, branching, compensation, waitFor/signal, concurrent executions
 * Requires a running bunqueue server (started by run-all-tests.ts)
 */

import { Workflow, Engine } from '../../src/client/workflow';

const TCP_PORT = parseInt(process.env.TCP_PORT ?? '16789');

let engine: Engine;
let passed = 0;
let failed = 0;

function pass(msg: string) {
  console.log(`   [PASS] ${msg}`);
  passed++;
}
function fail(msg: string, detail?: string) {
  console.log(`   [FAIL] ${msg}${detail ? ': ' + detail : ''}`);
  failed++;
}

async function cleanup() {
  if (engine) {
    try {
      await engine.close(true);
    } catch {}
  }
}

async function test1_linearFlow() {
  console.log('\n1. Linear workflow (3 steps with context passing)...');
  try {
    const log: string[] = [];

    const flow = new Workflow('tcp-linear')
      .step('a', async () => {
        log.push('a');
        return { x: 1 };
      })
      .step('b', async (ctx) => {
        log.push('b');
        const prev = ctx.steps['a'] as { x: number };
        return { x: prev.x + 1 };
      })
      .step('c', async (ctx) => {
        log.push('c');
        const prev = ctx.steps['b'] as { x: number };
        return { total: prev.x + 1 };
      });

    engine = new Engine({ connection: { port: TCP_PORT } });
    engine.register(flow);

    const run = await engine.start('tcp-linear', { seed: 42 });
    await Bun.sleep(3000);

    const exec = engine.getExecution(run.id);
    if (!exec) {
      fail('Linear flow', 'execution not found');
      await cleanup();
      return;
    }
    if (exec.state !== 'completed') {
      fail('Linear flow', `state=${exec.state}`);
      await cleanup();
      return;
    }
    if (log.join(',') !== 'a,b,c') {
      fail('Linear flow', `log=${log}`);
      await cleanup();
      return;
    }

    const result = exec.steps['c'].result as { total: number };
    if (result.total !== 3) {
      fail('Linear flow', `total=${result.total}`);
      await cleanup();
      return;
    }

    pass('Linear flow completed with correct context passing');
    await cleanup();
  } catch (e) {
    fail('Linear flow', String(e));
    await cleanup();
  }
}

async function test2_branching() {
  console.log('\n2. Branching workflow (VIP vs standard)...');
  try {
    const log: string[] = [];

    const flow = new Workflow('tcp-branch')
      .step('classify', async (ctx) => {
        const input = ctx.input as { tier: string };
        return { tier: input.tier };
      })
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

    engine = new Engine({ connection: { port: TCP_PORT } });
    engine.register(flow);

    const run = await engine.start('tcp-branch', { tier: 'vip' });
    await Bun.sleep(3000);

    const exec = engine.getExecution(run.id);
    if (!exec || exec.state !== 'completed') {
      fail('Branching', `state=${exec?.state}`);
      await cleanup();
      return;
    }
    if (!log.includes('vip') || log.includes('basic')) {
      fail('Branching', `wrong path: ${log}`);
      await cleanup();
      return;
    }
    if (!log.includes('done')) {
      fail('Branching', 'post-branch step not reached');
      await cleanup();
      return;
    }

    pass('Branching: VIP path taken correctly, basic skipped');
    await cleanup();
  } catch (e) {
    fail('Branching', String(e));
    await cleanup();
  }
}

async function test3_compensation() {
  console.log('\n3. Compensation (saga rollback on failure)...');
  try {
    const log: string[] = [];

    const flow = new Workflow('tcp-compensate')
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

    engine = new Engine({ connection: { port: TCP_PORT } });
    engine.register(flow);

    const run = await engine.start('tcp-compensate');
    await Bun.sleep(3000);

    const exec = engine.getExecution(run.id);
    if (!exec || exec.state !== 'failed') {
      fail('Compensation', `state=${exec?.state}`);
      await cleanup();
      return;
    }
    if (!log.includes('refund') || !log.includes('undo-create')) {
      fail('Compensation', `missing rollback: ${log}`);
      await cleanup();
      return;
    }
    if (log.indexOf('refund') >= log.indexOf('undo-create')) {
      fail('Compensation', `wrong order: ${log}`);
      await cleanup();
      return;
    }

    pass('Compensation: saga rollback ran in reverse order');
    await cleanup();
  } catch (e) {
    fail('Compensation', String(e));
    await cleanup();
  }
}

async function test4_waitForSignal() {
  console.log('\n4. WaitFor + Signal (human-in-the-loop)...');
  try {
    const log: string[] = [];

    const flow = new Workflow('tcp-signal')
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

    engine = new Engine({ connection: { port: TCP_PORT } });
    engine.register(flow);

    const run = await engine.start('tcp-signal');
    await Bun.sleep(1500);

    let exec = engine.getExecution(run.id);
    if (!exec || exec.state !== 'waiting') {
      fail('WaitFor', `expected waiting, got ${exec?.state}`);
      await cleanup();
      return;
    }

    await engine.signal(run.id, 'approval', { approved: true });
    await Bun.sleep(2000);

    exec = engine.getExecution(run.id);
    if (!exec || exec.state !== 'completed') {
      fail('WaitFor', `after signal: state=${exec?.state}`);
      await cleanup();
      return;
    }
    if (log.join(',') !== 'submit,approved') {
      fail('WaitFor', `log=${log}`);
      await cleanup();
      return;
    }

    pass('WaitFor + Signal: paused, then resumed on signal');
    await cleanup();
  } catch (e) {
    fail('WaitFor', String(e));
    await cleanup();
  }
}

async function test5_concurrentExecutions() {
  console.log('\n5. Concurrent executions (5 parallel runs)...');
  try {
    const flow = new Workflow('tcp-concurrent').step('compute', async (ctx) => {
      const input = ctx.input as { n: number };
      await Bun.sleep(50);
      return { result: input.n * 2 };
    });

    engine = new Engine({ connection: { port: TCP_PORT }, concurrency: 10 });
    engine.register(flow);

    const runs = await Promise.all(
      Array.from({ length: 5 }, (_, i) => engine.start('tcp-concurrent', { n: i }))
    );

    await Bun.sleep(4000);

    let allCompleted = true;
    for (const run of runs) {
      const exec = engine.getExecution(run.id);
      if (!exec || exec.state !== 'completed') {
        allCompleted = false;
        break;
      }
    }

    if (!allCompleted) {
      fail('Concurrent', 'not all executions completed');
      await cleanup();
      return;
    }

    pass('Concurrent: 5 parallel executions all completed');
    await cleanup();
  } catch (e) {
    fail('Concurrent', String(e));
    await cleanup();
  }
}

async function test6_ecommerceFlow() {
  console.log('\n6. E-commerce order flow (end-to-end)...');
  try {
    const db: Record<string, unknown> = {};

    const orderFlow = new Workflow<{ orderId: string; amount: number }>('tcp-order')
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
      .step('confirm', async (ctx) => {
        const tx = (ctx.steps['charge'] as { txId: string }).txId;
        return { confirmed: true, txId: tx };
      });

    engine = new Engine({ connection: { port: TCP_PORT } });
    engine.register(orderFlow);

    const run = await engine.start('tcp-order', { orderId: 'ORD-1', amount: 99.99 });
    await Bun.sleep(3500);

    const exec = engine.getExecution(run.id);
    if (!exec || exec.state !== 'completed') {
      fail('E-commerce', `state=${exec?.state}`);
      await cleanup();
      return;
    }
    if (db['stock'] !== 'reserved' || db['payment'] !== 'charged') {
      fail('E-commerce', `db state wrong`);
      await cleanup();
      return;
    }

    const confirm = exec.steps['confirm'].result as { confirmed: boolean; txId: string };
    if (confirm.txId !== 'tx_001') {
      fail('E-commerce', `txId=${confirm.txId}`);
      await cleanup();
      return;
    }

    pass('E-commerce: full order flow with context passing');
    await cleanup();
  } catch (e) {
    fail('E-commerce', String(e));
    await cleanup();
  }
}

async function test7_stepTimeout() {
  console.log('\n7. Step timeout...');
  try {
    const flow = new Workflow('tcp-timeout').step(
      'slow',
      async () => {
        await Bun.sleep(5000);
        return { done: true };
      },
      { timeout: 200, retry: 1 }
    );

    engine = new Engine({ connection: { port: TCP_PORT } });
    engine.register(flow);

    const run = await engine.start('tcp-timeout');
    await Bun.sleep(3000);

    const exec = engine.getExecution(run.id);
    if (!exec || exec.state !== 'failed') {
      fail('Step timeout', `state=${exec?.state}`);
      await cleanup();
      return;
    }
    if (!exec.steps['slow'].error?.includes('timed out')) {
      fail('Step timeout', `error=${exec.steps['slow'].error}`);
      await cleanup();
      return;
    }

    pass('Step timeout: slow step correctly timed out');
    await cleanup();
  } catch (e) {
    fail('Step timeout', String(e));
    await cleanup();
  }
}

async function test8_stepRetry() {
  console.log('\n8. Step retry with backoff...');
  try {
    let attempts = 0;

    const flow = new Workflow('tcp-retry').step(
      'flaky',
      async () => {
        attempts++;
        if (attempts < 3) throw new Error(`fail #${attempts}`);
        return { ok: true };
      },
      { retry: 3 }
    );

    engine = new Engine({ connection: { port: TCP_PORT } });
    engine.register(flow);

    const run = await engine.start('tcp-retry');
    await Bun.sleep(10_000);

    const exec = engine.getExecution(run.id);
    if (!exec || exec.state !== 'completed') {
      fail('Step retry', `state=${exec?.state}`);
      await cleanup();
      return;
    }
    if (attempts !== 3) {
      fail('Step retry', `attempts=${attempts}, expected 3`);
      await cleanup();
      return;
    }
    if (exec.steps['flaky'].attempts !== 3) {
      fail('Step retry', `recorded attempts=${exec.steps['flaky'].attempts}`);
      await cleanup();
      return;
    }

    pass('Step retry: succeeded on 3rd attempt after 2 failures');
    await cleanup();
  } catch (e) {
    fail('Step retry', String(e));
    await cleanup();
  }
}

async function test9_parallelSteps() {
  console.log('\n9. Parallel steps...');
  try {
    const startTimes: Record<string, number> = {};

    const flow = new Workflow('tcp-parallel')
      .step('init', async () => ({ ready: true }))
      .parallel((w) =>
        w
          .step('task-a', async () => {
            startTimes['a'] = Date.now();
            await Bun.sleep(200);
            return { a: true };
          })
          .step('task-b', async () => {
            startTimes['b'] = Date.now();
            await Bun.sleep(100);
            return { b: true };
          })
          .step('task-c', async () => {
            startTimes['c'] = Date.now();
            await Bun.sleep(150);
            return { c: true };
          })
      )
      .step('done', async () => ({ complete: true }));

    engine = new Engine({ connection: { port: TCP_PORT } });
    engine.register(flow);

    const run = await engine.start('tcp-parallel');
    await Bun.sleep(4000);

    const exec = engine.getExecution(run.id);
    if (!exec || exec.state !== 'completed') {
      fail('Parallel', `state=${exec?.state}`);
      await cleanup();
      return;
    }
    if (exec.steps['task-a']?.status !== 'completed') {
      fail('Parallel', 'task-a not completed');
      await cleanup();
      return;
    }
    if (exec.steps['task-b']?.status !== 'completed') {
      fail('Parallel', 'task-b not completed');
      await cleanup();
      return;
    }
    if (exec.steps['task-c']?.status !== 'completed') {
      fail('Parallel', 'task-c not completed');
      await cleanup();
      return;
    }
    if (exec.steps['done']?.status !== 'completed') {
      fail('Parallel', 'done step not completed');
      await cleanup();
      return;
    }

    // Check concurrency: start times should be within 100ms (TCP has more overhead)
    const times = Object.values(startTimes);
    const spread = Math.max(...times) - Math.min(...times);
    if (spread > 100) {
      fail('Parallel', `steps not concurrent, spread=${spread}ms`);
      await cleanup();
      return;
    }

    pass('Parallel: 3 steps ran concurrently, then continued to next step');
    await cleanup();
  } catch (e) {
    fail('Parallel', String(e));
    await cleanup();
  }
}

async function test10_signalTimeout() {
  console.log('\n10. Signal timeout...');
  try {
    const compensations: string[] = [];

    const flow = new Workflow('tcp-sig-timeout')
      .step('submit', async () => ({ ok: true }), {
        compensate: async () => {
          compensations.push('undo-submit');
        },
      })
      .waitFor('approval', { timeout: 1000 });

    engine = new Engine({ connection: { port: TCP_PORT } });
    engine.register(flow);

    const run = await engine.start('tcp-sig-timeout');
    await Bun.sleep(6000);

    const exec = engine.getExecution(run.id);
    if (!exec || exec.state !== 'failed') {
      fail('Signal timeout', `state=${exec?.state}`);
      await cleanup();
      return;
    }
    if (!exec.steps['__waitFor:approval']?.error?.includes('timed out')) {
      fail('Signal timeout', `error=${exec.steps['__waitFor:approval']?.error}`);
      await cleanup();
      return;
    }
    if (!compensations.includes('undo-submit')) {
      fail('Signal timeout', 'compensation not run');
      await cleanup();
      return;
    }

    pass('Signal timeout: workflow failed and compensation ran after timeout');
    await cleanup();
  } catch (e) {
    fail('Signal timeout', String(e));
    await cleanup();
  }
}

async function test11_cleanup() {
  console.log('\n11. Cleanup / archival...');
  try {
    const flow = new Workflow('tcp-cleanup').step('do', async () => ({ done: true }));

    engine = new Engine({ connection: { port: TCP_PORT } });
    engine.register(flow);

    await engine.start('tcp-cleanup');
    await engine.start('tcp-cleanup');
    await engine.start('tcp-cleanup');
    await Bun.sleep(3000);

    const before = engine.listExecutions('tcp-cleanup');
    if (before.length !== 3) {
      fail('Cleanup', `expected 3 executions, got ${before.length}`);
      await cleanup();
      return;
    }

    const archived = engine.archive(0);
    if (archived !== 3) {
      fail('Cleanup', `archived=${archived}, expected 3`);
      await cleanup();
      return;
    }
    if (engine.listExecutions('tcp-cleanup').length !== 0) {
      fail('Cleanup', 'executions not moved');
      await cleanup();
      return;
    }
    if (engine.getArchivedCount() !== 3) {
      fail('Cleanup', `archive count wrong`);
      await cleanup();
      return;
    }

    pass('Cleanup: 3 executions archived and removed from main table');
    await cleanup();
  } catch (e) {
    fail('Cleanup', String(e));
    await cleanup();
  }
}

async function test12_observability() {
  console.log('\n12. Observability (events)...');
  try {
    const events: string[] = [];

    const flow = new Workflow('tcp-events')
      .step('a', async () => ({ x: 1 }))
      .step('b', async () => ({ y: 2 }));

    engine = new Engine({ connection: { port: TCP_PORT } });
    engine.onAny((e) => events.push(e.type));
    engine.register(flow);

    await engine.start('tcp-events');
    await Bun.sleep(3000);

    if (!events.includes('workflow:started')) {
      fail('Observability', 'missing workflow:started');
      await cleanup();
      return;
    }
    if (!events.includes('step:started')) {
      fail('Observability', 'missing step:started');
      await cleanup();
      return;
    }
    if (!events.includes('step:completed')) {
      fail('Observability', 'missing step:completed');
      await cleanup();
      return;
    }
    if (!events.includes('workflow:completed')) {
      fail('Observability', 'missing workflow:completed');
      await cleanup();
      return;
    }

    pass('Observability: lifecycle events emitted correctly');
    await cleanup();
  } catch (e) {
    fail('Observability', String(e));
    await cleanup();
  }
}

async function test13_nestedWorkflow() {
  console.log('\n13. Nested workflows (sub-workflow)...');
  try {
    const child = new Workflow('tcp-child')
      .step('validate', async (ctx) => {
        const input = ctx.input as { amount: number };
        return { valid: input.amount > 0 };
      })
      .step('process', async () => ({ txId: 'tx_nested' }));

    const parent = new Workflow('tcp-parent')
      .step('create', async () => ({ orderId: 'ORD-N', total: 50 }))
      .subWorkflow('tcp-child', (ctx) => ({
        amount: (ctx.steps['create'] as { total: number }).total,
      }))
      .step('confirm', async (ctx) => {
        const sub = ctx.steps['sub:tcp-child'] as Record<string, unknown>;
        return { confirmed: true, childResult: sub };
      });

    engine = new Engine({ connection: { port: TCP_PORT } });
    engine.register(child);
    engine.register(parent);

    const run = await engine.start('tcp-parent');
    await Bun.sleep(12_000);

    const exec = engine.getExecution(run.id);
    if (!exec || exec.state !== 'completed') {
      fail('Nested', `state=${exec?.state}`);
      await cleanup();
      return;
    }
    if (exec.steps['sub:tcp-child']?.status !== 'completed') {
      fail('Nested', 'sub-workflow not completed');
      await cleanup();
      return;
    }
    if (exec.steps['confirm']?.status !== 'completed') {
      fail('Nested', 'confirm not completed');
      await cleanup();
      return;
    }

    const subResult = exec.steps['sub:tcp-child'].result as Record<string, unknown>;
    if (!(subResult['validate'] as { valid: boolean }).valid) {
      fail('Nested', 'child validate wrong');
      await cleanup();
      return;
    }

    pass('Nested: parent called child workflow, results passed back');
    await cleanup();
  } catch (e) {
    fail('Nested', String(e));
    await cleanup();
  }
}

async function test14_doUntilLoop() {
  console.log('\n14. doUntil loop...');
  try {
    let counter = 0;
    const flow = new Workflow('tcp-do-until').doUntil(
      (ctx) => (ctx.steps['inc'] as { count: number })?.count >= 3,
      (w) =>
        w.step(
          'inc',
          async () => {
            counter++;
            return { count: counter };
          },
          { retry: 1 }
        )
    );

    engine = new Engine({ connection: { port: TCP_PORT } });
    engine.register(flow);
    const run = await engine.start('tcp-do-until');
    await new Promise((r) => setTimeout(r, 8000));

    const exec = engine.getExecution(run.id);
    if (exec?.state !== 'completed') {
      fail('doUntil', `state=${exec?.state}`);
      await cleanup();
      return;
    }
    if (counter !== 3) {
      fail('doUntil', `counter=${counter}`);
      await cleanup();
      return;
    }
    pass('doUntil loop completed after 3 iterations');
    await cleanup();
  } catch (e) {
    fail('doUntil', String(e));
    await cleanup();
  }
}

async function test15_doWhileLoop() {
  console.log('\n15. doWhile loop...');
  try {
    let counter = 0;
    const flow = new Workflow('tcp-do-while').doWhile(
      (ctx) => {
        const val = (ctx.steps['proc'] as { value: number })?.value ?? 0;
        return val < 3;
      },
      (w) =>
        w.step(
          'proc',
          async () => {
            counter++;
            return { value: counter };
          },
          { retry: 1 }
        )
    );

    engine = new Engine({ connection: { port: TCP_PORT } });
    engine.register(flow);
    const run = await engine.start('tcp-do-while');
    await new Promise((r) => setTimeout(r, 8000));

    const exec = engine.getExecution(run.id);
    if (exec?.state !== 'completed') {
      fail('doWhile', `state=${exec?.state}`);
      await cleanup();
      return;
    }
    if (counter !== 3) {
      fail('doWhile', `counter=${counter}`);
      await cleanup();
      return;
    }
    pass('doWhile loop completed after 3 iterations');
    await cleanup();
  } catch (e) {
    fail('doWhile', String(e));
    await cleanup();
  }
}

async function test16_forEach() {
  console.log('\n16. forEach iteration...');
  try {
    const processed: string[] = [];
    const flow = new Workflow<{ items: string[] }>('tcp-foreach').forEach(
      (ctx) => (ctx.input as { items: string[] }).items,
      'handle',
      async (ctx) => {
        const item = ctx.steps.__item as string;
        processed.push(item);
        return { item };
      },
      { retry: 1 }
    );

    engine = new Engine({ connection: { port: TCP_PORT } });
    engine.register(flow);
    const run = await engine.start('tcp-foreach', { items: ['a', 'b', 'c'] });
    await new Promise((r) => setTimeout(r, 8000));

    const exec = engine.getExecution(run.id);
    if (exec?.state !== 'completed') {
      fail('forEach', `state=${exec?.state}`);
      await cleanup();
      return;
    }
    if (processed.length !== 3) {
      fail('forEach', `processed=${processed.length}`);
      await cleanup();
      return;
    }
    if (!exec.steps['handle:0'] || !exec.steps['handle:1'] || !exec.steps['handle:2']) {
      fail('forEach', 'missing indexed steps');
      await cleanup();
      return;
    }
    pass('forEach iterated over 3 items');
    await cleanup();
  } catch (e) {
    fail('forEach', String(e));
    await cleanup();
  }
}

async function test17_map() {
  console.log('\n17. map transform...');
  try {
    const flow = new Workflow('tcp-map')
      .step('fetch', async () => ({ values: [1, 2, 3] }), { retry: 1 })
      .map('sum', (ctx) => {
        const vals = (ctx.steps['fetch'] as { values: number[] }).values;
        return { total: vals.reduce((a, b) => a + b, 0) };
      })
      .step(
        'use',
        async (ctx) => {
          const total = (ctx.steps['sum'] as { total: number }).total;
          return { doubled: total * 2 };
        },
        { retry: 1 }
      );

    engine = new Engine({ connection: { port: TCP_PORT } });
    engine.register(flow);
    const run = await engine.start('tcp-map');
    await new Promise((r) => setTimeout(r, 6000));

    const exec = engine.getExecution(run.id);
    if (exec?.state !== 'completed') {
      fail('map', `state=${exec?.state}`);
      await cleanup();
      return;
    }
    if ((exec.steps['sum']?.result as { total: number })?.total !== 6) {
      fail('map', 'wrong sum');
      await cleanup();
      return;
    }
    if ((exec.steps['use']?.result as { doubled: number })?.doubled !== 12) {
      fail('map', 'wrong doubled');
      await cleanup();
      return;
    }
    pass('map transformed step results');
    await cleanup();
  } catch (e) {
    fail('map', String(e));
    await cleanup();
  }
}

async function test18_subscribe() {
  console.log('\n18. subscribe to execution events...');
  try {
    const events: string[] = [];
    const flow = new Workflow('tcp-sub')
      .step('a', async () => ({ ok: true }), { retry: 1 })
      .step('b', async () => ({ ok: true }), { retry: 1 });

    engine = new Engine({ connection: { port: TCP_PORT } });
    engine.register(flow);
    const run = await engine.start('tcp-sub');
    const unsub = engine.subscribe(run.id, (event) => {
      events.push(event.type);
    });
    await new Promise((r) => setTimeout(r, 5000));
    unsub();

    if (!events.includes('step:started')) {
      fail('subscribe', 'no step:started');
      await cleanup();
      return;
    }
    if (!events.includes('step:completed')) {
      fail('subscribe', 'no step:completed');
      await cleanup();
      return;
    }
    if (!events.includes('workflow:completed')) {
      fail('subscribe', 'no workflow:completed');
      await cleanup();
      return;
    }
    pass('subscribe received execution events');
    await cleanup();
  } catch (e) {
    fail('subscribe', String(e));
    await cleanup();
  }
}

async function test19_schemaValidation() {
  console.log('\n19. schema validation...');
  try {
    const inputSchema = {
      parse(data: unknown) {
        const obj = data as Record<string, unknown>;
        if (typeof obj.email !== 'string') throw new Error('email must be string');
        return obj;
      },
    };

    const flow = new Workflow('tcp-schema').step('validated', async (ctx) => ctx.input, {
      retry: 1,
      inputSchema,
    });

    engine = new Engine({ connection: { port: TCP_PORT } });
    engine.register(flow);

    // Valid input
    const run1 = await engine.start('tcp-schema', { email: 'test@test.com' });
    await new Promise((r) => setTimeout(r, 3000));
    if (engine.getExecution(run1.id)?.state !== 'completed') {
      fail('schema', 'valid input failed');
      await cleanup();
      return;
    }

    // Invalid input
    const run2 = await engine.start('tcp-schema', { email: 123 });
    await new Promise((r) => setTimeout(r, 3000));
    if (engine.getExecution(run2.id)?.state !== 'failed') {
      fail('schema', 'invalid input passed');
      await cleanup();
      return;
    }

    pass('schema validation works');
    await cleanup();
  } catch (e) {
    fail('schema', String(e));
    await cleanup();
  }
}

async function main() {
  console.log('=== Test Workflow Engine (TCP Mode) ===');
  console.log(`Connecting to server on port ${TCP_PORT}\n`);

  await test1_linearFlow();
  await test2_branching();
  await test3_compensation();
  await test4_waitForSignal();
  await test5_concurrentExecutions();
  await test6_ecommerceFlow();
  await test7_stepTimeout();
  await test8_stepRetry();
  await test9_parallelSteps();
  await test10_signalTimeout();
  await test11_cleanup();
  await test12_observability();
  await test13_nestedWorkflow();
  await test14_doUntilLoop();
  await test15_doWhileLoop();
  await test16_forEach();
  await test17_map();
  await test18_subscribe();
  await test19_schemaValidation();

  // Summary
  console.log('\n=== Summary ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);
