/**
 * Issue #34 - Cannot get parent result data
 *
 * Reproduces the bug where parent result data is unavailable in flow chains.
 *
 * Root cause: jobResults is a bounded map (maxJobResults, 5,000 at the time).
 * Without storage fallback (no DATA_PATH in embedded mode), evicted results
 * are permanently lost. getParentResult() returns undefined.
 *
 * Two failure modes:
 * 1. High throughput: many jobs complete, evicting parent results from cache
 * 2. completedJobs eviction: dependency resolution fails if parent's ID
 *    is evicted from completedJobs (50,000 limit)
 */

import { describe, test, expect, afterEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/application/types/config';
import { Queue, Worker, FlowProducer, shutdownManager } from '../src/client';
import { getSharedManager } from '../src/client/manager';
import { BoundedMap } from '../src/shared/boundedMap';

const tempDirs: string[] = [];
/** A fresh SQLite file for one test; removed after the run. */
function tempDataPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bunqueue-issue34-'));
  tempDirs.push(dir);
  return join(dir, 'queue.db');
}

/** Poll until `check` holds; fails the test after `timeoutMs`. */
async function waitUntil(check: () => Promise<boolean>, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('waitUntil: condition not met in time');
    await Bun.sleep(50);
  }
}

describe('Issue #34 - Parent result data missing', () => {
  afterEach(() => {
    shutdownManager();
  });
  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  test('BoundedMap FIFO eviction loses results that are still needed', () => {
    // Demonstrates the core design flaw: FIFO eviction doesn't consider
    // whether a result is still needed by a pending flow chain
    const map = new BoundedMap<string, unknown>(10);

    // Store 10 results (parent results from flow chains)
    for (let i = 0; i < 10; i++) {
      map.set(`parent-${i}`, { value: i * 10 });
    }
    expect(map.get('parent-0')).toEqual({ value: 0 });

    // Add one more - triggers FIFO eviction of oldest entry
    map.set('new-job', { value: 999 });

    // BUG: parent-0's result is evicted even though a child still needs it
    // With LRU, accessing parent-0 would keep it alive
    expect(map.get('parent-0')).toBeUndefined();
  });

  test('parent result lost after high throughput fills jobResults cache', async () => {
    // The guarantee of #34 holds with persistence: an evicted result is read back
    // from SQLite. (Memory-only mode bounds results by design.) The Queue comes
    // first so the shared embedded manager opens this database.
    const queue = new Queue('issue34-eviction', { embedded: true, dataPath: tempDataPath() });
    const flow = new FlowProducer({ embedded: true });
    queue.obliterate();

    // First: create a chain where we'll check parent result later
    const targetResults: Array<{ step: number; parentId: string; parentResult: unknown }> = [];
    let resolve: () => void;
    const done = new Promise<void>((r) => (resolve = r));

    // Track how many filler jobs completed
    let fillerCompleted = 0;
    // Must exceed the result cache (maxJobResults) so the flood really evicts.
    const FILLER_COUNT = DEFAULT_CONFIG.maxJobResults + 100;

    const worker = new Worker(
      'issue34-eviction',
      async (job) => {
        const data = job.data as {
          type: string;
          step?: number;
          fillerId?: number;
          __flowParentId?: string;
        };

        if (data.type === 'filler') {
          fillerCompleted++;
          return { filler: data.fillerId };
        }

        if (data.type === 'target') {
          if (data.__flowParentId) {
            const parentResult = flow.getParentResult(data.__flowParentId);
            targetResults.push({ step: data.step!, parentId: data.__flowParentId, parentResult });
          }
          if (data.step === 1) {
            resolve!();
          }
          return { targetStep: data.step };
        }

        return {};
      },
      { embedded: true, concurrency: 50 }
    );

    // Step 1: Create the target chain (step-0 → step-1)
    // step-0 completes first, result stored in jobResults
    await flow.addChain([
      {
        name: 'target-step-0',
        queueName: 'issue34-eviction',
        data: { type: 'target', step: 0 },
      },
      {
        name: 'target-step-1',
        queueName: 'issue34-eviction',
        data: { type: 'target', step: 1 },
      },
    ]);

    // Wait for chain to complete
    await done;
    await Bun.sleep(200);

    // At this point, target-step-0's result should be in jobResults
    // Now verify it's accessible
    expect(targetResults.length).toBe(1);
    expect(targetResults[0].parentResult).toBeDefined();

    // Step 2: Flood with filler jobs to trigger FIFO eviction
    let fillerResolve: () => void;
    const fillerDone = new Promise<void>((r) => (fillerResolve = r));

    const fillerWorkerDoneCheck = setInterval(() => {
      if (fillerCompleted >= FILLER_COUNT) {
        clearInterval(fillerWorkerDoneCheck);
        fillerResolve!();
      }
    }, 100);

    // Push filler jobs in bulk
    for (let batch = 0; batch < FILLER_COUNT / 50; batch++) {
      const jobs = Array.from({ length: 50 }, (_, i) => ({
        name: 'filler',
        data: { type: 'filler', fillerId: batch * 50 + i },
      }));
      await queue.addBulk(jobs);
    }

    await fillerDone;
    await Bun.sleep(500);

    // Step 3: Now try to get the target chain's parent result again.
    // Issue #34: FIFO eviction used to lose it once the filler jobs completed;
    // it must still be readable after the flood.
    expect(await flow.getParentResult<{ targetStep: number }>(targetResults[0].parentId)).toEqual({
      targetStep: 0,
    });

    // Create another chain that depends on results still being available
    // Create a new chain - step-0 result will be stored
    await flow.addChain([
      {
        name: 'late-step-0',
        queueName: 'issue34-eviction',
        data: { type: 'target', step: 0 },
      },
      {
        name: 'late-step-1',
        queueName: 'issue34-eviction',
        data: { type: 'target', step: 1 },
      },
    ]);

    // Wait for the late chain to process
    await new Promise<void>((r) => {
      const check = setInterval(() => {
        if (targetResults.length >= 2) {
          clearInterval(check);
          r();
        }
      }, 100);
    });
    await Bun.sleep(200);

    // The late chain's parent result should still be available
    // (it was just added, not yet evicted)
    const lateResult = targetResults[1];
    expect(lateResult.parentResult).toBeDefined();

    await worker.close();
    flow.close();
    queue.close();
  }, 60000);

  test('getChildrenValues reads evicted children results back from SQLite', async () => {
    // Issue #34 for getChildrenValues: while the parent is live its children's
    // results are pinned in memory (the dependency tracker), so the storage
    // fallback only matters once the parent has completed. Order: children and
    // parent complete, then more than maxJobResults other jobs complete (the
    // jobResults LRU evicts the children's results), then the parent's children
    // values are read. Nothing reads the children's results before the flood.
    const queue = new Queue('issue34-children-evict', { embedded: true, dataPath: tempDataPath() });
    const flow = new FlowProducer({ embedded: true });
    queue.obliterate();

    let fillerCompleted = 0;
    // Must exceed the result cache (maxJobResults) so the flood really evicts.
    const FILLER_COUNT = DEFAULT_CONFIG.maxJobResults + 100;

    const worker = new Worker(
      'issue34-children-evict',
      async (job) => {
        const data = job.data as { role: string; value?: number };
        if (data.role === 'filler') {
          fillerCompleted++;
          return { filler: true };
        }
        if (data.role === 'child') return { childValue: (data.value ?? 0) * 10 };
        return { summary: 'done' };
      },
      { embedded: true, concurrency: 50 }
    );

    // Step 1: parent waits for 2 children; the whole flow completes.
    const node = await flow.add({
      name: 'parent',
      queueName: 'issue34-children-evict',
      data: { role: 'parent' },
      children: [
        { name: 'child-a', queueName: 'issue34-children-evict', data: { role: 'child', value: 1 } },
        { name: 'child-b', queueName: 'issue34-children-evict', data: { role: 'child', value: 2 } },
      ],
    });
    const parentId = node.job.id;
    const childIds = (node.children ?? []).map((child) => child.job.id);
    expect(childIds).toHaveLength(2);
    await waitUntil(async () => (await queue.getJobState(parentId)) === 'completed');

    // Step 2: flood with filler jobs; their results push the children's results
    // out of the in-memory jobResults LRU.
    for (let batch = 0; batch < FILLER_COUNT / 50; batch++) {
      const jobs = Array.from({ length: 50 }, () => ({ name: 'filler', data: { role: 'filler' } }));
      await queue.addBulk(jobs);
    }
    await waitUntil(async () => {
      if (fillerCompleted < FILLER_COUNT) return false;
      return (await queue.getJobCounts()).completed >= FILLER_COUNT + 3;
    });

    // Precondition: the children's results are gone from memory (has() does not
    // refresh LRU recency), so the read below can only be served by SQLite.
    const internals = getSharedManager() as unknown as {
      jobResults: { has(id: string): boolean };
      dependencyResults: { has(id: string): boolean };
    };
    for (const id of childIds) {
      expect(internals.jobResults.has(id)).toBe(false);
      expect(internals.dependencyResults.has(id)).toBe(false);
    }

    // Step 3: issue #34: evicted children results used to be lost (empty values);
    // with persistence they are read back from storage.
    const childrenValues = await queue.getChildrenValues(parentId);
    expect(childrenValues).toEqual({
      [`issue34-children-evict:${childIds[0]}`]: { childValue: 10 },
      [`issue34-children-evict:${childIds[1]}`]: { childValue: 20 },
    });

    await worker.close();
    flow.close();
    queue.close();
  }, 120000);
});
