/**
 * A child that exhausts its attempts outside a worker FAIL — interrupted by a broker
 * crash (startup recovery), by an expired lock, or by stall detection — still fails
 * terminally, so its flow policy must apply exactly as on the FAIL path
 * (docs: guide/flow/failures — "when a child fails terminally (no retries left)").
 *
 * Found by a production-style FlowProducer campaign (50,100 jobs, broker SIGKILLs):
 * 21 parents stayed in `waiting-children` forever; every stuck child was in the DLQ
 * with "Job reached max attempts (6) during startup recovery" or "Lock expired at
 * max attempts (6)", and no flow_failures record existed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import { jobId, type JobId } from '../src/domain/types/job';
import { shardIndex } from '../src/shared/hash';

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

function open(dataPath: string, extra: Record<string, unknown> = {}): QueueManager {
  const manager = new QueueManager({ dataPath, ...extra });
  managers.push(manager);
  return manager;
}

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

const PARENT_QUEUE = 'policy-parents';
const CHILD_QUEUE = 'policy-children';

/** One parent waiting on one single-attempt child carrying `policy`. */
async function pushFlow(
  manager: QueueManager,
  label: string,
  policy: Policy
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
    [policy]: true,
    customId: String(childId),
    data: { name: 'child', __parentId: String(parent.id), __parentQueue: PARENT_QUEUE },
    durable: true,
    maxAttempts: 1,
    parentId: parent.id,
  });
  return { parentId: parent.id, childId };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(25);
  }
  return check();
}

/** The parent outcome the worker-FAIL path produces for each policy. */
async function expectPolicyApplied(
  manager: QueueManager,
  policy: Policy,
  parentId: JobId,
  childId: JobId
): Promise<void> {
  expect(await manager.getJobState(childId)).toBe('failed');
  if (policy === 'failParentOnFailure') {
    expect(await waitFor(async () => (await manager.getJobState(parentId)) === 'failed')).toBe(
      true
    );
    return;
  }
  expect(
    await waitFor(async () => (await manager.getJobState(parentId)) !== 'waiting-children')
  ).toBe(true);
  if (policy === 'ignoreDependencyOnFailure') {
    expect(Object.keys(await manager.getIgnoredChildrenFailures(parentId))).toHaveLength(1);
  }
  if (policy === 'continueParentOnFailure') {
    expect(Object.keys(await manager.getFailedChildrenValues(parentId))).toHaveLength(1);
  }
}

function tempDataPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'bunqueue-flow-policy-exhaustion-'));
  directories.push(directory);
  return join(directory, 'queue.db');
}

describe('flow policies apply when recovery exhausts a child', () => {
  for (const policy of POLICIES) {
    test(`control: a terminal worker FAIL applies ${policy}`, async () => {
      const manager = open(tempDataPath());
      const { parentId, childId } = await pushFlow(manager, `control-${policy}`, policy);
      expect((await manager.pull(CHILD_QUEUE))?.id).toBe(childId);
      await manager.fail(childId, 'worker failure');
      await expectPolicyApplied(manager, policy, parentId, childId);
    }, 15_000);

    test(`startup recovery after a crash: ${policy}`, async () => {
      const dataPath = tempDataPath();
      const crashed = open(dataPath);
      const { parentId, childId } = await pushFlow(crashed, `startup-${policy}`, policy);
      expect((await crashed.pull(CHILD_QUEUE))?.id).toBe(childId);
      // The child is active on disk when the broker dies.
      crashed.shutdown();

      const recovered = open(dataPath);
      await expectPolicyApplied(recovered, policy, parentId, childId);
    }, 15_000);

    test(`expired lock at max attempts: ${policy}`, async () => {
      const manager = open(tempDataPath(), { stallCheckMs: 100 });
      const { parentId, childId } = await pushFlow(manager, `lock-${policy}`, policy);
      const { job } = await manager.pullWithLock(CHILD_QUEUE, 'frozen-worker', 0, 50);
      expect(job?.id).toBe(childId);
      expect(await waitFor(async () => (await manager.getJobState(childId)) === 'failed')).toBe(
        true
      );
      await expectPolicyApplied(manager, policy, parentId, childId);
    }, 15_000);

    test(`stall detection at max attempts: ${policy}`, async () => {
      const manager = open(tempDataPath(), { stallCheckMs: 100 });
      manager.getShards()[shardIndex(CHILD_QUEUE)].setStallConfig(CHILD_QUEUE, {
        stallInterval: 100,
        gracePeriod: 0,
      });
      const { parentId, childId } = await pushFlow(manager, `stall-${policy}`, policy);
      expect((await manager.pull(CHILD_QUEUE))?.id).toBe(childId);
      expect(await waitFor(async () => (await manager.getJobState(childId)) === 'failed')).toBe(
        true
      );
      await expectPolicyApplied(manager, policy, parentId, childId);
    }, 15_000);
  }
});
