/**
 * Edge cases of applying a flow child's failure policy from a recovery sweep: the
 * dashboard event, the maxStalls bound, a policy that throws, and a sweep whose
 * later write throws after earlier children were already moved to the DLQ.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import { checkExpiredLocks } from '../src/application/lockManager';
import type { LockContext } from '../src/application/types';
import { jobId, type JobId } from '../src/domain/types/job';
import { shardIndex } from '../src/shared/hash';

const PARENT_QUEUE = 'edge-policy-parents';
const CHILD_QUEUE = 'edge-policy-children';

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
  const directory = mkdtempSync(join(tmpdir(), 'bunqueue-flow-policy-edges-'));
  directories.push(directory);
  return join(directory, 'queue.db');
}

function open(dataPath: string, stallCheckMs = 60_000): QueueManager {
  const manager = new QueueManager({ dataPath, stallCheckMs });
  managers.push(manager);
  return manager;
}

function close(manager: QueueManager): void {
  managers.splice(managers.indexOf(manager), 1);
  manager.shutdown();
}

function lockContext(manager: QueueManager): LockContext {
  return (
    manager as unknown as { contextFactory: { getLockContext(): LockContext } }
  ).contextFactory.getLockContext();
}

async function pushFlow(
  manager: QueueManager,
  label: string,
  childOptions: Record<string, unknown>
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
    maxAttempts: 1,
    ...childOptions,
    customId: String(childId),
    data: { name: 'child', __parentId: String(parent.id), __parentQueue: PARENT_QUEUE },
    durable: true,
    parentId: parent.id,
  });
  return { parentId: parent.id, childId };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(20);
  }
  return check();
}

/** Lease every waiting child with a 5 ms lock and let the locks expire. */
async function leaseAndExpire(manager: QueueManager, count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    const { job } = await manager.pullWithLock(CHILD_QUEUE, 'frozen-worker', 0, 5);
    expect(job).not.toBeNull();
  }
  await Bun.sleep(20);
}

describe('flow policy edges on recovery sweeps', () => {
  test('the background lock sweep emits flow:failed only for a child with a policy', async () => {
    const manager = open(tempDataPath(), 100);
    const events: Array<Record<string, unknown>> = [];
    manager.setDashboardEmit((event, data) => {
      if (event === 'flow:failed') events.push(data);
    });
    const withPolicy = await pushFlow(manager, 'event-policy', { failParentOnFailure: true });
    const withoutPolicy = await pushFlow(manager, 'event-none', {});
    await leaseAndExpire(manager, 2);

    expect(
      await waitFor(async () => (await manager.getJobState(withPolicy.parentId)) === 'failed')
    ).toBe(true);
    expect(
      await waitFor(async () => (await manager.getJobState(withoutPolicy.childId)) === 'failed')
    ).toBe(true);
    // As on a worker FAIL: one child-level event, then the parent-level one.
    expect(events.map((event) => [event.failedChildId, event.queue])).toEqual([
      [String(withPolicy.childId), CHILD_QUEUE],
      [String(withPolicy.childId), PARENT_QUEUE],
    ]);
    expect(await manager.getJobState(withoutPolicy.parentId)).toBe('waiting-children');
  }, 15_000);

  test('a lock expiry that exhausts maxStalls with attempts left applies the policy', async () => {
    const manager = open(tempDataPath());
    manager.getShards()[shardIndex(CHILD_QUEUE)].setStallConfig(CHILD_QUEUE, { maxStalls: 1 });
    const { parentId, childId } = await pushFlow(manager, 'max-stalls', {
      continueParentOnFailure: true,
      maxAttempts: 5,
    });
    await leaseAndExpire(manager, 1);
    await checkExpiredLocks(lockContext(manager));

    expect(await manager.getJobState(childId)).toBe('failed');
    expect(await manager.getJobState(parentId)).not.toBe('waiting-children');
    expect(Object.keys(await manager.getFailedChildrenValues(parentId))).toHaveLength(1);
  }, 15_000);

  test('a policy that throws is logged, and the durable record applies it on restart', async () => {
    const dataPath = tempDataPath();
    const first = open(dataPath);
    const { parentId, childId } = await pushFlow(first, 'throwing', {
      failParentOnFailure: true,
    });
    await leaseAndExpire(first, 1);
    const ctx: LockContext = {
      ...lockContext(first),
      onChildTerminalFailure: async () => {
        throw new Error('policy callback failed');
      },
    };
    await checkExpiredLocks(ctx);
    expect(await first.getJobState(childId)).toBe('failed');
    expect(await first.getJobState(parentId)).toBe('waiting-children');
    close(first);

    const reopened = open(dataPath);
    expect(await reopened.getJobState(parentId)).toBe('failed');
  }, 15_000);

  test('children moved before a later write throws still reach their parents', async () => {
    const manager = open(tempDataPath());
    const flows = [
      await pushFlow(manager, 'finally-a', { failParentOnFailure: true }),
      await pushFlow(manager, 'finally-b', { failParentOnFailure: true }),
    ];
    await leaseAndExpire(manager, 2);
    const ctx = lockContext(manager);
    const storage = ctx.storage!;
    const commitFailedJob = storage.commitFailedJob.bind(storage);
    let calls = 0;
    const failingStorage = Object.create(storage) as typeof storage;
    failingStorage.commitFailedJob = (...args) => {
      if (++calls === 2) throw new Error('second write failed');
      commitFailedJob(...args);
    };

    await expect(checkExpiredLocks({ ...ctx, storage: failingStorage })).rejects.toThrow(
      'second write failed'
    );
    const parentStates = await Promise.all(
      flows.map(({ parentId }) => manager.getJobState(parentId))
    );
    expect(parentStates.filter((state) => state === 'failed')).toHaveLength(1);
  }, 15_000);
});
