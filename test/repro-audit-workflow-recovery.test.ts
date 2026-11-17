import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shutdownManager } from '../src/client';
import { Engine, Workflow, type Execution } from '../src/client/workflow';

let directory: string;
let engine: Engine;

function openEngine(): Engine {
  return new Engine({
    embedded: true,
    dataPath: join(directory, 'workflow.sqlite'),
    queueName: `nested-workflow-${directory.split('/').pop()}`,
    concurrency: 5,
  });
}

beforeEach(() => {
  shutdownManager();
  directory = mkdtempSync(join(tmpdir(), 'bunqueue-nested-'));
  engine = openEngine();
});

afterEach(async () => {
  try {
    await engine.close(true);
  } finally {
    shutdownManager();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function restart(): Promise<void> {
  await engine.close(true);
  shutdownManager();
  engine = openEngine();
}

async function observe(
  read: () => Execution | null | undefined,
  predicate: (row: Execution) => boolean,
  description: string
): Promise<Execution> {
  const deadline = Date.now() + 8_000;
  do {
    const row = read();
    if (row && predicate(row)) return row;
    await Bun.sleep(10);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}

function settledParent(id: string): Promise<Execution> {
  return observe(
    () => engine.getExecution(id),
    (row) => row.rollbackStatus !== undefined,
    'the parent rollback outcome'
  );
}

/** The child holds a resource while the parent awaits an external decision. */
async function startApproval() {
  const effects = { allocated: 0, reversed: 0 };
  const child = new Workflow('reserve', { revision: 1 }).step(
    'allocate',
    () => ++effects.allocated,
    {
      compensate: () => {
        effects.reversed++;
      },
    }
  );
  const parent = new Workflow('order')
    .subWorkflow(child.name, () => ({}), { pollInterval: 10 })
    .waitFor('decision')
    .step(
      'confirm',
      () => {
        throw new Error('Order rejected');
      },
      { retry: 1 }
    );
  engine.register(child).register(parent);
  const run = await engine.start(parent.name);
  const parked = await observe(
    () => engine.getExecution(run.id),
    (row) => row.state === 'waiting',
    'the parent to wait after the child completed'
  );
  const childId = parked.steps['sub:reserve']?.childExecutionId;
  if (!childId) throw new Error('Expected the parent to record its child');
  expect(engine.getExecution(childId)?.steps.allocate.compensatable).toBe(true);
  expect(effects).toEqual({ allocated: 1, reversed: 0 });
  return { parent, child, run, childId, effects };
}

describe('nested workflow recovery and rollback', () => {
  test.each(['uninterrupted', 'restarted'] as const)(
    'the %s engine expires the child signal gate before the parent deadline',
    async (lifecycle) => {
      const child = new Workflow('review').waitFor('approved', { timeout: 850 });
      const parent = new Workflow('order').subWorkflow(child.name, () => ({}), {
        pollInterval: 15,
        timeout: 2_500,
      });
      engine.register(child).register(parent);
      const run = await engine.start(parent.name);
      const parked = await observe(
        () => engine.listExecutions(child.name, 'waiting')[0],
        (row) => row.parentExecutionId === run.id,
        'the nested timed gate to park'
      );

      if (lifecycle === 'restarted') {
        await restart();
        engine.register(child).register(parent);
        await engine.recover();
      }
      const result = await settledParent(run.id);
      const childResult = engine.getExecution(parked.id);
      expect({
        child: childResult?.state,
        childFailure: childResult?.failureReason,
        parent: result.state,
        rollback: result.rollbackStatus,
      }).toEqual({
        child: 'failed',
        childFailure: 'Signal "approved" timed out after 850ms',
        parent: 'failed',
        rollback: 'completed',
      });
    },
    15_000
  );

  test.each(['no maintenance', 'archive', 'cleanup'] as const)(
    'a pending parent can reverse its completed child after %s',
    async (operation) => {
      const { run, effects } = await startApproval();
      if (operation !== 'no maintenance') {
        const other = new Workflow('standalone').step('finish', () => true);
        engine.register(other);
        const independent = await engine.start(other.name);
        await observe(
          () => engine.getExecution(independent.id),
          (row) => row.state === 'completed',
          'the independent execution to complete'
        );
        expect(engine[operation](0)).toBeGreaterThanOrEqual(1);
        expect(engine.getExecution(independent.id)).toBeNull();
      }
      await engine.signal(run.id, 'decision');
      const result = await settledParent(run.id);
      expect({
        effects,
        rollback: result.rollbackStatus,
        child: result.steps['sub:reserve'].compensation?.status,
      }).toEqual({
        effects: { allocated: 1, reversed: 1 },
        rollback: 'completed',
        child: 'compensated',
      });
    },
    15_000
  );

  test.each(['original', 'changed'] as const)(
    'rolling back under the %s child revision only reports reversals actually performed',
    async (revision) => {
      const { run, effects, parent, child, childId } = await startApproval();
      await restart();
      const changed = new Workflow(child.name, { revision: 2 }).step('allocate', () => 1);
      try {
        engine.register(revision === 'original' ? child : changed).register(parent);
        await engine.recover();
      } catch (error) {
        // Registration or recovery may reject the incompatible definition before rollback.
        if (revision !== 'changed') throw error;
        expect(String(error)).toMatch(/definition mismatch/i);
        await restart();
        engine.register(child).register(parent);
        await engine.recover();
      }
      await engine.signal(run.id, 'decision');
      const result = await settledParent(run.id);
      if (revision === 'changed' && effects.reversed === 0) {
        expect({
          parent: result.state,
          rollback: result.rollbackStatus,
          child: result.steps['sub:reserve'].compensation?.status,
        }).toEqual({
          parent: 'compensation-stuck',
          rollback: 'stuck',
          child: 'compensation-failed',
        });
      } else {
        expect(effects).toEqual({ allocated: 1, reversed: 1 });
        expect(result.rollbackStatus).toBe('completed');
        expect(result.steps['sub:reserve'].compensation?.status).toBe('compensated');
        expect(engine.getExecution(childId)?.steps.allocate.compensation?.status).toBe(
          'compensated'
        );
      }
    },
    15_000
  );
});
