/**
 * Issue #155 B: how `cancelWithOutcome` retries a refused Cancel.
 *
 * A refusal is retried only when the state read after it is removable and differs from
 * the state read after the previous refusal, so a real transition between the refusal
 * and the read (an active job completing) still removes the job, while a stable refusal
 * of a removable state (a PostgreSQL waiting producer that a live job depends on) stops
 * after two attempts instead of spending every attempt. The number of attempts never
 * exceeds `MAX_CANCEL_ATTEMPTS`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import {
  cancelWithOutcome,
  MAX_CANCEL_ATTEMPTS,
  type CancelPort,
} from '../src/domain/job/cancellation';
import { jobId, type JobId } from '../src/domain/types/job';

/** A port answering from scripted sequences, counting every call. */
function scriptedPort(cancels: boolean[], states: string[]) {
  const calls = { cancel: 0, getJobState: 0 };
  const port: CancelPort = {
    cancel: async () => cancels[Math.min(calls.cancel++, cancels.length - 1)],
    getJobState: async () => states[Math.min(calls.getJobState++, states.length - 1)],
  };
  return { port, calls };
}

const ID = jobId('job-1');

describe('cancelWithOutcome with a fake port', () => {
  test('a job removed at once needs one attempt and no state read', async () => {
    const { port, calls } = scriptedPort([true], ['completed']);
    expect(await cancelWithOutcome(port, ID)).toEqual({ removed: true });
    expect(calls).toEqual({ cancel: 1, getJobState: 0 });
  });

  test('a missing job answers unknown after one attempt', async () => {
    const { port, calls } = scriptedPort([false], ['unknown']);
    expect(await cancelWithOutcome(port, ID)).toEqual({ removed: false, state: 'unknown' });
    expect(calls).toEqual({ cancel: 1, getJobState: 1 });
  });

  test('a stable non-removable refusal stops after one attempt', async () => {
    for (const state of ['active', 'failed']) {
      const { port, calls } = scriptedPort([false], [state]);
      expect(await cancelWithOutcome(port, ID)).toEqual({ removed: false, state });
      expect(calls).toEqual({ cancel: 1, getJobState: 1 });
    }
  });

  test('a job that completed after the refusal is removed by the retry', async () => {
    const { port, calls } = scriptedPort([false, true], ['completed']);
    expect(await cancelWithOutcome(port, ID)).toEqual({ removed: true });
    expect(calls).toEqual({ cancel: 2, getJobState: 1 });
  });

  test('a stable refusal of a removable state stops after two attempts', async () => {
    const { port, calls } = scriptedPort([false], ['waiting']);
    expect(await cancelWithOutcome(port, ID)).toEqual({ removed: false, state: 'waiting' });
    expect(calls).toEqual({ cancel: 2, getJobState: 2 });
  });

  test('a refusal that moves to a non-removable state stops there', async () => {
    const { port, calls } = scriptedPort([false], ['completed', 'active']);
    expect(await cancelWithOutcome(port, ID)).toEqual({ removed: false, state: 'active' });
    expect(calls).toEqual({ cancel: 2, getJobState: 2 });
  });

  test('a job moving between removable states never exceeds the attempt bound', async () => {
    const { port, calls } = scriptedPort(
      [false],
      ['waiting', 'delayed', 'waiting', 'delayed', 'waiting']
    );
    expect(MAX_CANCEL_ATTEMPTS).toBe(3);
    expect(await cancelWithOutcome(port, ID)).toEqual({ removed: false, state: 'waiting' });
    expect(calls).toEqual({ cancel: MAX_CANCEL_ATTEMPTS, getJobState: MAX_CANCEL_ATTEMPTS });
  });
});

describe('cancelWithOutcome on the real engine', () => {
  let manager: QueueManager | null = null;

  afterEach(() => {
    manager?.shutdown();
    manager = null;
  });

  test('a job acked between the refused Cancel and the state read is removed', async () => {
    manager = new QueueManager();
    const qm = manager;
    const pushed = await qm.push('outcome-race', { data: { secret: 'payload' } });
    const pulled = await qm.pull('outcome-race');
    expect(pulled?.id).toBe(pushed.id);
    const cancels: boolean[] = [];
    const states: string[] = [];
    let acked = false;
    // Wraps the real manager: the worker's ACK lands right after the first refusal.
    const port: CancelPort = {
      cancel: async (id: JobId) => {
        const removed = await qm.cancel(id);
        cancels.push(removed);
        return removed;
      },
      getJobState: async (id: JobId) => {
        if (!acked) {
          acked = true;
          await qm.ack(id, { answer: 42 });
        }
        const state = await qm.getJobState(id);
        states.push(state);
        return state;
      },
    };

    expect(await cancelWithOutcome(port, pushed.id)).toEqual({ removed: true });

    expect(cancels).toEqual([false, true]);
    expect(states).toEqual(['completed']);
    expect(await qm.getJobState(pushed.id)).toBe('unknown');
    expect(await qm.getJob(pushed.id)).toBeNull();
    expect(qm.getResult(pushed.id)).toBeUndefined();
  });
});
