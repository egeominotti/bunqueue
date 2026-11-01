/**
 * Durability of a flow child's failure policy when a recovery sweep (lock expiry or
 * stall detection) exhausts it: the flow_failures record commits with the DLQ move,
 * so a broker that dies before the in-memory parent effect still applies the policy
 * on the next start. Children without a policy keep the previous behavior.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import { checkExpiredLocks } from '../src/application/lockManager';
import { handleStalledJob } from '../src/application/stallDetection';
import type { BackgroundContext, LockContext } from '../src/application/types';
import { jobId, type JobId } from '../src/domain/types/job';
import { StallAction } from '../src/domain/types/stall';
import { processingShardIndex } from '../src/shared/hash';

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

const PARENT_QUEUE = 'durable-policy-parents';
const CHILD_QUEUE = 'durable-policy-children';

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
  const directory = mkdtempSync(join(tmpdir(), 'bunqueue-flow-policy-durability-'));
  directories.push(directory);
  return join(directory, 'queue.db');
}

function open(dataPath: string): QueueManager {
  // Background sweeps stay idle: each scenario drives its sweep by hand.
  const manager = new QueueManager({ dataPath, stallCheckMs: 60_000 });
  managers.push(manager);
  return manager;
}

/** Stop a broker the scenario is done with; `afterEach` only stops the others. */
function close(manager: QueueManager): void {
  managers.splice(managers.indexOf(manager), 1);
  manager.shutdown();
}

interface ContextFactoryAccess {
  contextFactory: {
    getLockContext(): LockContext;
    getBackgroundContext(): BackgroundContext;
  };
}

/** The sweep context of a broker that dies before the in-memory parent effect. */
function crashingLockContext(manager: QueueManager): LockContext {
  const ctx = (manager as unknown as ContextFactoryAccess).contextFactory.getLockContext();
  return { ...ctx, onChildTerminalFailure: undefined, onChildDependencyOption: undefined };
}

function crashingBackgroundContext(manager: QueueManager): BackgroundContext {
  const ctx = (manager as unknown as ContextFactoryAccess).contextFactory.getBackgroundContext();
  return { ...ctx, onChildTerminalFailure: undefined, onChildDependencyOption: undefined };
}

async function pushFlow(
  manager: QueueManager,
  label: string,
  policy: Policy | null
): Promise<{ parentId: JobId; childId: JobId }> {
  const childId = jobId(`${label}-child`);
  const parent = await manager.push(PARENT_QUEUE, {
    customId: `${label}-parent`,
    data: { name: 'parent' },
    dependsOn: [childId],
    childrenIds: [childId],
    durable: true,
  });
  await manager.push(CHILD_QUEUE, {
    ...(policy ? { [policy]: true } : {}),
    customId: String(childId),
    data: { name: 'child', __parentId: String(parent.id), __parentQueue: PARENT_QUEUE },
    durable: true,
    maxAttempts: 1,
    parentId: parent.id,
  });
  return { parentId: parent.id, childId };
}

async function expectPolicyAppliedAfterRestart(
  manager: QueueManager,
  policy: Policy,
  parentId: JobId,
  childId: JobId
): Promise<void> {
  expect(await manager.getJobState(childId)).toBe('failed');
  const parentState = await manager.getJobState(parentId);
  if (policy === 'failParentOnFailure') {
    expect(parentState).toBe('failed');
    return;
  }
  expect(parentState).not.toBe('waiting-children');
  if (policy === 'ignoreDependencyOnFailure') {
    expect(Object.keys(await manager.getIgnoredChildrenFailures(parentId))).toHaveLength(1);
  }
  if (policy === 'continueParentOnFailure') {
    expect(Object.keys(await manager.getFailedChildrenValues(parentId))).toHaveLength(1);
  }
}

/** Expire the child's lock and run the lock sweep without the in-memory flow effect. */
async function expireLockAndCrash(manager: QueueManager, childId: JobId): Promise<void> {
  const { job } = await manager.pullWithLock(CHILD_QUEUE, 'frozen-worker', 0, 5);
  expect(job?.id).toBe(childId);
  await Bun.sleep(20);
  await checkExpiredLocks(crashingLockContext(manager));
}

/** Confirm the child stalled and run the stall handler without the in-memory flow effect. */
async function stallAndCrash(manager: QueueManager, childId: JobId): Promise<void> {
  expect((await manager.pull(CHILD_QUEUE))?.id).toBe(childId);
  const ctx = crashingBackgroundContext(manager);
  const active = ctx.processingShards[processingShardIndex(childId)].get(childId);
  expect(active).toBeDefined();
  expect(await handleStalledJob(active!, StallAction.Retry, ctx)).toBe(true);
}

const SWEEPS = [
  { name: 'expired lock', run: expireLockAndCrash },
  { name: 'stall detection', run: stallAndCrash },
] as const;

describe('a recovery sweep persists the flow policy with the DLQ move', () => {
  for (const sweep of SWEEPS) {
    for (const policy of POLICIES) {
      test(`${sweep.name}, crash before the parent effect: ${policy}`, async () => {
        const dataPath = tempDataPath();
        const crashed = open(dataPath);
        const label = `${sweep.name.replace(' ', '-')}-${policy}`;
        const { parentId, childId } = await pushFlow(crashed, label, policy);
        await sweep.run(crashed, childId);
        expect(await crashed.getJobState(childId)).toBe('failed');
        // The in-memory effect never ran: only the durable record can resolve the parent.
        expect(await crashed.getJobState(parentId)).toBe('waiting-children');
        close(crashed);

        const recovered = open(dataPath);
        await expectPolicyAppliedAfterRestart(recovered, policy, parentId, childId);
      }, 15_000);
    }

    test(`${sweep.name}: a child without a policy leaves its parent waiting`, async () => {
      const dataPath = tempDataPath();
      const first = open(dataPath);
      const label = `${sweep.name.replace(' ', '-')}-no-policy`;
      const { parentId, childId } = await pushFlow(first, label, null);
      await sweep.run(first, childId);
      expect(await first.getJobState(childId)).toBe('failed');
      expect(await first.getJobState(parentId)).toBe('waiting-children');
      close(first);

      const reopened = open(dataPath);
      expect(await reopened.getJobState(childId)).toBe('failed');
      expect(await reopened.getJobState(parentId)).toBe('waiting-children');
    }, 15_000);
  }
});
