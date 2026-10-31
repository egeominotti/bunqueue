/**
 * Issue #82: job.moveToFailed() inside processor marks job as completed instead of failed
 *
 * Root cause: processor.ts does not pass moveToFailed/moveToCompleted callbacks
 * to createPublicJob, so these methods are silent no-ops inside the processor.
 * After the processor returns normally, the worker auto-ACKs → job = completed.
 *
 * @see https://github.com/egeominotti/bunqueue/issues/82
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Queue, Worker, shutdownManager } from '../src/client';

describe('Issue #82: moveToFailed inside processor', () => {
  let queue: Queue<{ syncId?: string }>;

  beforeEach(() => {
    queue = new Queue('issue-82', { embedded: true });
    queue.obliterate();
  });

  afterEach(() => {
    queue.close();
    shutdownManager();
  });

  test('job.moveToFailed() should fail the job (not complete it)', async () => {
    const events: string[] = [];

    const job = await queue.add('test', { syncId: 's' }, { attempts: 1 });

    const worker = new Worker<{ syncId?: string }>(
      'issue-82',
      async (j) => {
        // This is the exact pattern from the issue reporter:
        // call moveToFailed and return (no throw)
        if (j.data.syncId) {
          await j.moveToFailed(new Error('intentional failure'));
          return;
        }
        return { ok: true };
      },
      { embedded: true, autorun: true }
    );

    worker.on('completed', () => events.push('completed'));
    worker.on('failed', () => events.push('failed'));

    await Bun.sleep(500);

    const state = await queue.getJobState(job.id);

    // BUG: currently state === 'completed' and events === ['completed']
    // EXPECTED: state === 'failed' and events contains 'failed'
    expect(state).toBe('failed');
    expect(events).toContain('failed');
    expect(events).not.toContain('completed');

    await worker.close();
  });

  test('job.moveToCompleted() inside processor should complete with custom result', async () => {
    let capturedResult: unknown;

    const job = await queue.add('test', {});

    const worker = new Worker(
      'issue-82',
      async (j) => {
        await j.moveToCompleted({ custom: 'result' });
        return; // return without value — moveToCompleted should have set the result
      },
      { embedded: true, autorun: true }
    );

    worker.on('completed', (_j, result) => {
      capturedResult = result;
    });

    await Bun.sleep(500);

    const state = await queue.getJobState(job.id);
    expect(state).toBe('completed');
    // The custom moveToCompleted() value, not the processor's undefined return,
    // is the result delivered to the 'completed' listener.
    expect(capturedResult).toEqual({ custom: 'result' });

    await worker.close();
  });

  test('moveToFailed prevents auto-ACK (no double state transition)', async () => {
    const events: string[] = [];

    await queue.add('test', { syncId: 'x' }, { attempts: 1 });

    const worker = new Worker(
      'issue-82',
      async (j) => {
        await j.moveToFailed(new Error('fail reason'));
        // Processor returns normally — worker should NOT auto-ACK
        return 'this should be ignored';
      },
      { embedded: true, autorun: true }
    );

    worker.on('completed', () => events.push('completed'));
    worker.on('failed', () => events.push('failed'));

    await Bun.sleep(500);

    // Should have exactly one event, and it should be 'failed'
    expect(events).toEqual(['failed']);

    await worker.close();
  });
});
