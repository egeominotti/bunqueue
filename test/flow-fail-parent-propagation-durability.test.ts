/**
 * Durability of a failParentOnFailure propagation: a parent that its child moves to
 * `failed` commits its own policy record (toward its parent) with its DLQ move, and the
 * startup outbox replay propagates the same way. A broker that dies between "mid failed"
 * and "grandparent updated", or before "mid failed", still resolves the grandparent on
 * the next start. A middle node without a policy keeps the grandparent waiting.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import type { Job } from '../src/domain/types/job';
import { jobId, type JobId } from '../src/domain/types/job';

type Policy =
  | 'failParentOnFailure'
  | 'ignoreDependencyOnFailure'
  | 'removeDependencyOnFailure'
  | 'continueParentOnFailure';

const POLICIES: Policy[] = [
  'failParentOnFailure',
  'ignoreDependencyOnFailure',
  'removeDependencyOnFailure',
  'continueParentOnFailure',
];

const QUEUE = 'fpof-propagation-durability';
const directories: string[] = [];
const managers: QueueManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) {
    try {
      manager.shutdown();
    } catch {
      // Already shut down by the scenario.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDataPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'bunqueue-fpof-propagation-durability-'));
  directories.push(directory);
  return join(directory, 'queue.db');
}

function open(dataPath: string): QueueManager {
  const manager = new QueueManager({ dataPath, stallCheckMs: 60_000 });
  managers.push(manager);
  return manager;
}

function close(manager: QueueManager): void {
  managers.splice(managers.indexOf(manager), 1);
  manager.shutdown();
}

type FailStep = (parentId: JobId, childJob: Job, error: string | undefined) => Promise<unknown>;
type DependencyOption = (childJob: Job, error: string | undefined) => Promise<void>;

/**
 * Simulate a broker that dies after `completedSteps` parent moves: the rest of the
 * in-memory propagation (a further parent move, or the middle node's dependency
 * option on the grandparent) never runs, so only the durable outbox can finish it.
 */
function crashAfterSteps(manager: QueueManager, completedSteps: number): void {
  const access = manager as unknown as {
    failParentForChild: FailStep;
    onChildDependencyOption: DependencyOption;
  };
  const original = access.failParentForChild.bind(manager);
  let steps = 0;
  access.failParentForChild = async (parentId, childJob, error) => {
    if (steps++ >= completedSteps) return null;
    return original(parentId, childJob, error);
  };
  // The leaf carries failParentOnFailure: only the middle node reaches this option.
  access.onChildDependencyOption = async () => {};
}

interface Chain {
  readonly ids: JobId[];
}

/** A linear chain root <- ... <- leaf; `policies[i]` belongs to node i + 1. */
async function pushChain(
  manager: QueueManager,
  label: string,
  policies: Array<Policy | null>
): Promise<Chain> {
  const ids = [jobId(`${label}-root`)];
  for (let index = 0; index < policies.length; index++) ids.push(jobId(`${label}-n${index + 1}`));
  for (let index = 0; index < ids.length; index++) {
    const childId = ids[index + 1];
    const parentId = ids[index - 1];
    const policy = index === 0 ? null : policies[index - 1];
    await manager.push(QUEUE, {
      ...(policy ? { [policy]: true } : {}),
      customId: String(ids[index]),
      data: parentId ? { __parentId: String(parentId), __parentQueue: QUEUE } : {},
      ...(childId ? { dependsOn: [childId], childrenIds: [childId] } : {}),
      ...(parentId ? { parentId } : {}),
      durable: true,
      maxAttempts: 1,
    });
  }
  return { ids };
}

async function failLeaf(manager: QueueManager, leafId: JobId): Promise<void> {
  const pulled = await manager.pull(QUEUE);
  expect(pulled?.id).toBe(leafId);
  await manager.fail(leafId, 'boom');
  expect(await manager.getJobState(leafId)).toBe('failed');
}

async function expectGrandparent(
  manager: QueueManager,
  policy: Policy,
  grandparentId: JobId,
  midId: JobId
): Promise<void> {
  expect(await manager.getJobState(midId)).toBe('failed');
  const state = await manager.getJobState(grandparentId);
  if (policy === 'failParentOnFailure') {
    expect(state).toBe('failed');
    return;
  }
  expect(state).toBe('waiting');
  const key = `${QUEUE}:${String(midId)}`;
  if (policy === 'ignoreDependencyOnFailure') {
    const ignored = await manager.getIgnoredChildrenFailures(grandparentId);
    expect(ignored[key]).toContain('failed: boom');
  }
  if (policy === 'continueParentOnFailure') {
    const failed = await manager.getFailedChildrenValues(grandparentId);
    expect(failed[key]).toContain('failed: boom');
  }
}

const CRASH_POINTS = [
  { name: 'after the middle node failed', steps: 1 },
  { name: 'before the middle node failed', steps: 0 },
] as const;

describe('a propagated flow policy survives a crash', () => {
  for (const crash of CRASH_POINTS) {
    for (const policy of POLICIES) {
      test(`crash ${crash.name}: ${policy} on the middle node`, async () => {
        const dataPath = tempDataPath();
        const crashed = open(dataPath);
        const label = `s${crash.steps}-${policy}`;
        const { ids } = await pushChain(crashed, label, [policy, 'failParentOnFailure']);
        const [grandparentId, midId, leafId] = ids;
        crashAfterSteps(crashed, crash.steps);
        await failLeaf(crashed, leafId);
        expect(await crashed.getJobState(midId)).toBe(
          crash.steps === 0 ? 'waiting-children' : 'failed'
        );
        expect(await crashed.getJobState(grandparentId)).toBe('waiting-children');
        close(crashed);

        const recovered = open(dataPath);
        await expectGrandparent(recovered, policy, grandparentId, midId);
        close(recovered);

        // A later restart replays the retained records without changing the outcome.
        const again = open(dataPath);
        await expectGrandparent(again, policy, grandparentId, midId);
      }, 15_000);
    }

    test(`crash ${crash.name}: no policy on the middle node keeps it waiting`, async () => {
      const dataPath = tempDataPath();
      const crashed = open(dataPath);
      const { ids } = await pushChain(crashed, `s${crash.steps}-none`, [
        null,
        'failParentOnFailure',
      ]);
      const [grandparentId, midId, leafId] = ids;
      crashAfterSteps(crashed, crash.steps);
      await failLeaf(crashed, leafId);
      close(crashed);

      const recovered = open(dataPath);
      expect(await recovered.getJobState(midId)).toBe('failed');
      expect(await recovered.getJobState(grandparentId)).toBe('waiting-children');
    }, 15_000);
  }

  test('the startup replay propagates failParentOnFailure through four levels', async () => {
    const dataPath = tempDataPath();
    const crashed = open(dataPath);
    const fpof = 'failParentOnFailure' as const;
    const { ids } = await pushChain(crashed, 'deep', [fpof, fpof, fpof]);
    crashAfterSteps(crashed, 0);
    await failLeaf(crashed, ids[3]);
    for (const id of ids.slice(0, 3)) {
      expect(await crashed.getJobState(id)).toBe('waiting-children');
    }
    close(crashed);

    const recovered = open(dataPath);
    for (const id of ids) expect(await recovered.getJobState(id)).toBe('failed');
  }, 15_000);
});
