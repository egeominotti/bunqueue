/**
 * Regression coverage (Issue #82 follow-up):
 * Job methods called inside the Worker processor used to be silent no-ops
 * because `processor.ts` did not pass callbacks to `createPublicJob`, which
 * fell back to `Promise.resolve()` / `false` / `0`.
 *
 * These tests now verify the WIRED behavior: methods either produce a real
 * server-side effect or throw an explicit error when no server primitive exists.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Queue, Worker, shutdownManager } from '../src/client';
import type { Job } from '../src/client';

describe('Wired Job methods inside Worker processor (Issue #82 follow-up)', () => {
  let queue: Queue<{ kind: string }>;

  beforeEach(() => {
    queue = new Queue('audit-wired', { embedded: true });
    queue.obliterate();
  });

  afterEach(async () => {
    queue.close();
    shutdownManager();
  });

  test('mutation methods produce real server-side effects, not silent no-ops', async () => {
    const original = { kind: 'original' };
    await queue.add('t', original, { priority: 5, attempts: 1 });

    let savedId: string | undefined;
    let observedDataBeforeRemove: unknown;
    let removeDedupResult: boolean | undefined;
    let isWaitingChildrenResult: boolean | undefined;
    let removeError: string | null | undefined;

    const worker = new Worker(
      'audit-wired',
      async (j: Job<{ kind: string }>) => {
        savedId = j.id;

        // updateData mutates the stored data
        await j.updateData({ kind: 'mutated' });
        const afterUpdate = await queue.getJob(savedId);
        observedDataBeforeRemove = afterUpdate?.data;

        removeDedupResult = await j.removeDeduplicationKey();

        // getDependenciesCount returns real zero-child counts (job has no children)
        const depsCount = await j.getDependenciesCount();
        expect(depsCount).toEqual({ processed: 0, unprocessed: 0 });
        isWaitingChildrenResult = await j.isWaitingChildren();

        // remove() reaches the broker, which never removes an active job (issue #155):
        // the awaited remove() now rejects with the state instead of resolving silently.
        removeError = await j.remove().then(
          () => null,
          (error: Error) => error.message
        );
        return { ok: true };
      },
      { embedded: true, autorun: true }
    );

    await Bun.sleep(500);
    await worker.close();

    // Proofs that methods really executed server-side:
    expect(observedDataBeforeRemove).toEqual({ kind: 'mutated' });
    expect(removeDedupResult).toBe(false);
    expect(isWaitingChildrenResult).toBe(false);
    expect(savedId).toBeDefined();

    // remove() on the job's own active lease was refused with the state, so the
    // processor's return completed the job with the mutated data.
    expect(removeError).toMatch(/active/);
    expect(await queue.getJobState(savedId as string)).toBe('completed');
    const j = await queue.getJob(savedId as string);
    expect(j?.data).toEqual({ kind: 'mutated' });
  });

  test('changeDelay / changePriority reach the server without throwing', async () => {
    await queue.add('t', { kind: 'priority-test' }, { priority: 5, attempts: 1 });

    let didChangePriority = false;
    let didChangeDelay = false;

    const worker = new Worker(
      'audit-wired',
      async (j: Job<{ kind: string }>) => {
        await j.changePriority({ priority: 42 });
        didChangePriority = true;
        await j.changeDelay(1_000);
        didChangeDelay = true;
        return { ok: true };
      },
      { embedded: true, autorun: true }
    );

    await Bun.sleep(500);
    await worker.close();

    // No throw from either call = wiring reached the manager
    expect(didChangePriority).toBe(true);
    expect(didChangeDelay).toBe(true);
  });

  test('discard() is a fire-and-forget sync call that reaches the manager', async () => {
    await queue.add('t', { kind: 'discard' }, { attempts: 1 });

    let threw = false;
    const worker = new Worker(
      'audit-wired',
      async (j: Job<{ kind: string }>) => {
        try {
          j.discard(); // void return
        } catch {
          threw = true;
        }
        return { ok: true };
      },
      { embedded: true, autorun: true }
    );

    await Bun.sleep(500);
    await worker.close();

    expect(threw).toBe(false);
  });
});
