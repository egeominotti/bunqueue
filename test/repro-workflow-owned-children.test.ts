import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Unpackr } from 'msgpackr';
import { shutdownManager, type Queue } from '../src/client';
import { Engine, Workflow, type Execution } from '../src/client/workflow';
import { WorkflowStore } from '../src/client/workflow/store';
import { waitForWorkflowState } from './workflowTestUtils';

const close: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (close.length) await close.pop()?.();
});

function database(): string {
  shutdownManager();
  const dir = mkdtempSync(join(tmpdir(), 'bq-owned-workflows-'));
  close.push(() => {
    shutdownManager();
    rmSync(dir, { recursive: true, force: true });
  });
  return join(dir, 'runs.sqlite');
}

function execution(id: string, changes: Partial<Execution> = {}): Execution {
  return {
    id,
    workflowName: id,
    state: 'completed',
    input: {},
    steps: {},
    currentNodeIndex: 1,
    signals: {},
    createdAt: 1,
    updatedAt: 1,
    ...changes,
  };
}

function link(id: string) {
  return { status: 'completed', childExecutionId: id } as const;
}

test.each(['archive', 'cleanup'] as const)(
  '%s releases decoded parent payloads during the scan',
  (operation) => {
    const store = new WorkflowStore(database());
    close.push(() => store.close());
    const result = new Uint8Array(256 * 1024);
    const decision = new Uint8Array(64 * 1024);
    for (let index = 0; index < 130; index++) {
      const child = `child-${index}`;
      const parent = `parent-${index}`;
      store.save(
        execution(parent, {
          state: 'waiting',
          decisions: { input: decision },
          steps: { unrelated: { status: 'completed', result }, [`sub:${child}`]: link(child) },
        })
      );
      store.save(execution(child, { parentExecutionId: parent }));
    }

    // Sample after collection while SQLite is still scanning. Measuring after the
    // call returns would miss the ownership cache's entire lifetime.
    Bun.gc(true);
    const baseline = process.memoryUsage().arrayBuffers;
    let peakGrowth = 0;
    let decoded = 0;
    const unpack = Unpackr.prototype.unpack;
    Unpackr.prototype.unpack = function (data, options) {
      if (++decoded % 32 === 0) {
        Bun.gc(true);
        peakGrowth = Math.max(peakGrowth, process.memoryUsage().arrayBuffers - baseline);
      }
      return unpack.call(this, data, options);
    };
    try {
      expect(store[operation](0)).toBe(0);
    } finally {
      Unpackr.prototype.unpack = unpack;
    }
    expect(store.get('child-129')?.parentExecutionId).toBe('parent-129');
    expect(peakGrowth, `peak live buffer growth in ${operation}, bytes`).toBeLessThan(
      4 * 1024 * 1024
    );
  }
);

test.each(['archive', 'cleanup'] as const)(
  '%s retains nested rollback across completed intermediates and releases it at the pivot',
  (operation) => {
    const store = new WorkflowStore(database());
    close.push(() => store.close());
    const root = execution('root', { state: 'waiting', steps: { 'sub:middle': link('middle') } });
    const middle = execution('middle', { parentExecutionId: root.id });
    for (let index = 0; index < 1_001; index++) {
      const id = `leaf-${index}`;
      middle.steps[`sub:${id}`] = link(id);
      store.save(execution(id, { parentExecutionId: middle.id }));
    }
    store.save(root);
    store.save(middle);
    store.save(execution('unrelated', { updatedAt: 2 }));

    expect(store[operation](0)).toBe(1);
    expect(store.get('unrelated')).toBeNull();
    expect(store.get('leaf-1000')?.parentExecutionId).toBe(middle.id);

    root.committedAt = 1;
    store.update(root);
    if (operation === 'archive') {
      expect(store.archive(0)).toBe(1_000);
      expect(store.archive(0)).toBe(2);
      expect(store.getArchivedCount()).toBe(1_003);
    } else {
      expect(store.cleanup(0)).toBe(1_002);
    }
    expect(store.get('middle')).toBeNull();
    expect(store.get('root')?.state).toBe('waiting');
    expect(store[operation](0)).toBe(0);
  }
);

test.each(['archive', 'cleanup'] as const)(
  '%s keeps an owed failure and a child whose committed parent has yet to read the result',
  (operation) => {
    const store = new WorkflowStore(database());
    close.push(() => store.close());
    store.save(
      execution('before-unwind', { state: 'failed', steps: { 'sub:owed': link('owed') } })
    );
    store.save(execution('owed', { parentExecutionId: 'before-unwind' }));
    store.save(execution('committed', { committedAt: 0, state: 'running' }));
    store.save(execution('unclaimed', { parentExecutionId: 'committed' }));
    store.save(execution('terminal', { state: 'failed', rollbackStatus: 'completed' }));
    store.save(execution('released', { parentExecutionId: 'terminal' }));

    expect(store[operation](0)).toBe(2);
    for (const id of ['before-unwind', 'owed', 'unclaimed']) expect(store.get(id)).toBeTruthy();
    expect(store.get('released')).toBeNull();
    expect(store.get('terminal')).toBeNull();
  }
);

test.each(['changed revision', 'legacy missing handler'] as const)(
  'a %s parks the ancestor until the original child handler is restored',
  async (scenario) => {
    const path = database();
    let reversals = 0;
    let wrongReversals = 0;
    const child = new Workflow('child', { revision: 1 }).step('reserve', () => 1, {
      compensate: () => {
        reversals++;
      },
    });
    const replacement = new Workflow('child', { revision: 2 }).step(
      'reserve',
      () => 1,
      scenario === 'changed revision'
        ? {
            compensate: () => {
              wrongReversals++;
            },
          }
        : {}
    );
    const parent = new Workflow('parent').subWorkflow('child', () => ({}));
    const store = new WorkflowStore(path);
    try {
      store.save(
        execution('child', {
          parentExecutionId: 'parent',
          definitionHash: scenario === 'changed revision' ? child.seal() : undefined,
          steps: { reserve: { status: 'completed', compensatable: true, result: 1 } },
        })
      );
      store.save(
        execution('parent', {
          state: 'failed',
          failureReason: 'downstream failed',
          steps: { 'sub:child': link('child') },
        })
      );
    } finally {
      store.close();
    }

    let engine = new Engine({ embedded: true, dataPath: path });
    close.push(() => engine.close(true));
    engine.register(parent).register(replacement);
    await engine.recover();
    expect(wrongReversals).toBe(0);
    expect(engine.getExecution('parent')?.rollbackStatus).toBe('stuck');
    expect(engine.getExecution('parent')?.steps['sub:child'].compensation?.status).toBe(
      'compensation-failed'
    );

    await engine.close(true);
    shutdownManager();
    engine = new Engine({ embedded: true, dataPath: path });
    engine.register(parent).register(child);
    await engine.resumeCompensation('parent');
    expect(engine.getExecution('parent')?.rollbackStatus).toBe('completed');
    expect(engine.getExecution('child')?.steps.reserve.compensation?.status).toBe('compensated');
    expect(reversals).toBe(1);
  }
);

test('a nested legacy gate that expired during downtime settles even when its parent has parked', async () => {
  const path = database();
  const store = new WorkflowStore(path);
  try {
    store.save(
      execution('parent', {
        state: 'compensation-stuck',
        rollbackStatus: 'stuck',
        steps: {
          'sub:child': {
            ...link('child'),
            status: 'failed',
            compensation: { status: 'compensation-failed', at: 1 },
          },
        },
      })
    );
    store.save(
      execution('child', {
        state: 'waiting',
        parentExecutionId: 'parent',
        steps: { reserve: { status: 'completed', compensatable: true } },
      })
    );
  } finally {
    store.close();
  }
  let reversals = 0;
  const child = new Workflow('child')
    .step('reserve', () => 1, {
      compensate: () => {
        reversals++;
      },
    })
    .waitFor('approval', { timeout: 60_000 });
  const engine = new Engine({ embedded: true, dataPath: path });
  close.push(() => engine.close(true));
  engine.register(child).register(new Workflow('parent').subWorkflow('child', () => ({})));
  await engine.recover();
  await engine.recover();
  await waitForWorkflowState(engine, 'child', 'failed', 1500);
  expect(engine.getExecution('child')?.failureReason).toBe(
    'Signal "approval" timed out after 60000ms'
  );
  await engine.resumeCompensation('parent');
  expect(engine.getExecution('parent')?.rollbackStatus).toBe('completed');
  expect(reversals).toBe(1);
});

test('a failed publication of an overdue child gate leaves it reachable under its parked parent', async () => {
  const path = database();
  const store = new WorkflowStore(path);
  try {
    store.save(execution('parent', { state: 'compensation-stuck', rollbackStatus: 'stuck' }));
    store.save(
      execution('child', {
        state: 'waiting',
        parentExecutionId: 'parent',
        currentNodeIndex: 0,
        steps: { '__waitFor:approval': { status: 'running', startedAt: 1 } },
      })
    );
  } finally {
    store.close();
  }
  const engine = new Engine({ embedded: true, dataPath: path });
  close.push(() => engine.close(true));
  engine.register(new Workflow('child').waitFor('approval', { timeout: 60_000 }));
  const attempted = Promise.withResolvers<void>();
  const queue = (engine as unknown as { queue: Queue }).queue;
  const publish = spyOn(queue, 'add').mockImplementationOnce(async () => {
    attempted.resolve();
    throw new Error('gate publication failed');
  });
  try {
    await engine.recover().catch((error) => {
      expect(String(error)).toContain('gate publication failed');
    });
    await attempted.promise;
    expect(engine.getExecution('child')?.state).toBe('waiting');
  } finally {
    publish.mockRestore();
  }
  await engine.signal('child', 'approval');
  const finished = await waitForWorkflowState(engine, 'child', 'completed');
  expect(finished?.state).toBe('completed');
});
