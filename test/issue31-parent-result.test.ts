/**
 * Issue #31 - Not being able to fetch parent data in chained jobs
 *
 * Reproduces the bug where child jobs in a chain cannot fetch
 * the parent job's result. Tests both addChain() and add() flows.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { Queue, Worker, FlowProducer, shutdownManager } from '../src/client';

describe('Issue #31 - Parent result in chained jobs', () => {
  afterEach(() => {
    shutdownManager();
  });

  // A single chain reading its parent's result on the first call, and a parent
  // reading all children values: flow-advanced.test.ts.
  test('addChain: many concurrent chains - parent results always available', async () => {
    const flow = new FlowProducer({ embedded: true });
    const queue = new Queue('chain-stress', { embedded: true });
    queue.obliterate();

    const CHAIN_COUNT = 20;
    const STEPS_PER_CHAIN = 5;
    const failures: string[] = [];
    let completedChains = 0;
    let resolve: () => void;
    const done = new Promise<void>((r) => (resolve = r));

    const worker = new Worker(
      'chain-stress',
      async (job) => {
        const data = job.data as {
          step: number;
          chainId: number;
          __flowParentId?: string;
        };

        if (data.__flowParentId) {
          const parentResult = flow.getParentResult<{ value: number }>(data.__flowParentId) as
            { value: number } | undefined;
          if (parentResult === undefined) {
            failures.push(
              `Chain ${data.chainId} step ${data.step}: parent result undefined (parentId: ${data.__flowParentId})`
            );
          } else if (parentResult.value !== (data.step - 1) * 100 + data.chainId) {
            failures.push(
              `Chain ${data.chainId} step ${data.step}: wrong parent result ${JSON.stringify(parentResult)}`
            );
          }
        }

        if (data.step === STEPS_PER_CHAIN - 1) {
          completedChains++;
          if (completedChains === CHAIN_COUNT) resolve!();
        }

        return { value: data.step * 100 + data.chainId };
      },
      { embedded: true, concurrency: 3 }
    );

    // Create many chains concurrently
    const chainPromises = Array.from({ length: CHAIN_COUNT }, (_, chainId) =>
      flow.addChain(
        Array.from({ length: STEPS_PER_CHAIN }, (_, step) => ({
          name: `step-${step}`,
          queueName: 'chain-stress',
          data: { step, chainId },
        }))
      )
    );
    await Promise.all(chainPromises);

    await done;
    await Bun.sleep(100);

    if (failures.length > 0) {
      console.log('Failures:', failures);
    }
    expect(failures).toHaveLength(0);

    await worker.close();
    flow.close();
    queue.close();
  });

  test('add() with children: parent processes before children complete (race)', async () => {
    /**
     * This test exposes the race condition:
     * In FlowProducer.add(), the parent job has NO dependsOn on children.
     * Parent can be pulled and processed BEFORE children complete.
     * getChildrenValues() then returns empty/partial results.
     */
    const flow = new FlowProducer({ embedded: true });
    const queue = new Queue('flow-race', { embedded: true });
    queue.obliterate();

    const results: Array<{
      parentId: string;
      childrenValues: Record<string, unknown>;
      childrenCount: number;
    }> = [];
    const FLOW_COUNT = 10;
    let completedParents = 0;
    let resolve: () => void;
    const done = new Promise<void>((r) => (resolve = r));

    const worker = new Worker(
      'flow-race',
      async (job) => {
        const data = job.data as { role: string; value: number; flowIdx?: number };

        if (data.role === 'child') {
          // Simulate some work
          await Bun.sleep(Math.random() * 10);
          return { childResult: data.value };
        }

        // Parent - immediately try getChildrenValues
        const childrenValues = await queue.getChildrenValues(job.id);
        results.push({
          parentId: job.id,
          childrenValues,
          childrenCount: Object.keys(childrenValues).length,
        });

        completedParents++;
        if (completedParents === FLOW_COUNT) resolve!();
        return { parentDone: true };
      },
      { embedded: true, concurrency: 5 }
    );

    // Create multiple flows concurrently
    for (let i = 0; i < FLOW_COUNT; i++) {
      await flow.add({
        name: 'parent',
        queueName: 'flow-race',
        data: { role: 'parent', value: 0, flowIdx: i },
        children: [
          { name: 'child-1', queueName: 'flow-race', data: { role: 'child', value: 1 } },
          { name: 'child-2', queueName: 'flow-race', data: { role: 'child', value: 2 } },
          { name: 'child-3', queueName: 'flow-race', data: { role: 'child', value: 3 } },
        ],
      });
    }

    await done;
    await Bun.sleep(200);

    // Check how many parents got all 3 children values
    const fullResults = results.filter((r) => r.childrenCount === 3);
    const partialResults = results.filter((r) => r.childrenCount < 3);

    if (partialResults.length > 0) {
      console.log(
        `RACE CONDITION: ${partialResults.length}/${FLOW_COUNT} parents got partial/empty children values`
      );
      for (const r of partialResults) {
        console.log(`  Parent ${r.parentId}: got ${r.childrenCount}/3 children values`);
      }
    }

    // BUG: In the current implementation, parent jobs are NOT held
    // until children complete (addWaitingParent is never called).
    // So parents may process before children, getting empty results.
    // This assertion documents the expected behavior:
    expect(fullResults.length).toBe(FLOW_COUNT);

    await worker.close();
    flow.close();
    queue.close();
  });
});
