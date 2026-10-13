/**
 * A Cancel that reports the job missing drops the job's removed-result record on every
 * transport (companion of test/repro-cancel-ack-race-removed-result.test.ts).
 *
 * `cancelWithOutcome` calls the port's optional `forgetRemovedResult` only when the final
 * state is `unknown`, after the state read: an ACK (`removeOnComplete`) that lands
 * between the refused Cancel and that read re-records the result, and the TCP handler,
 * HTTP `DELETE /jobs/:id` and the embedded `removeAsync()` all report such a job missing.
 * A refusal that names a state (active, failed) keeps the result of a later completion,
 * which is a real one.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { getSharedManager, shutdownManager } from '../src/client/manager';
import { removeJob } from '../src/client/jobRemoval';
import {
  CANCEL_JOB_NOT_FOUND_ERROR,
  cancelWithOutcome,
  type CancelPort,
} from '../src/domain/job/cancellation';
import { jobId, type JobId } from '../src/domain/types/job';
import { handleCancel } from '../src/infrastructure/server/handlers/management';
import { routeJobRoutes } from '../src/infrastructure/server/httpRouteJobs';
import type { HandlerContext } from '../src/infrastructure/server/types';

let manager: QueueManager | null = null;

afterEach(() => {
  manager?.shutdown();
  manager = null;
  shutdownManager();
});

/** A port answering from scripted sequences and recording every forget. */
function scriptedPort(cancels: boolean[], states: string[]) {
  const forgotten: JobId[] = [];
  let cancelCalls = 0;
  let stateCalls = 0;
  const port: CancelPort = {
    cancel: async () => cancels[Math.min(cancelCalls++, cancels.length - 1)],
    getJobState: async () => states[Math.min(stateCalls++, states.length - 1)],
    forgetRemovedResult: (id) => {
      forgotten.push(id);
    },
  };
  return { port, forgotten };
}

const ID = jobId('job-1');

describe('cancelWithOutcome and forgetRemovedResult', () => {
  test('a missing job drops the record once', async () => {
    const { port, forgotten } = scriptedPort([false], ['unknown']);
    expect(await cancelWithOutcome(port, ID)).toEqual({ removed: false, state: 'unknown' });
    expect(forgotten).toEqual([ID]);
  });

  test('a job that vanished after a removable read drops the record once', async () => {
    const { port, forgotten } = scriptedPort([false], ['completed', 'unknown']);
    expect(await cancelWithOutcome(port, ID)).toEqual({ removed: false, state: 'unknown' });
    expect(forgotten).toEqual([ID]);
  });

  test('a removal or a named refusal leaves the record alone', async () => {
    for (const [cancels, states] of [
      [[true], ['unknown']],
      [[false, true], ['completed']],
      [[false], ['active']],
      [[false], ['failed']],
      [[false], ['waiting']],
    ] as const) {
      const { port, forgotten } = scriptedPort([...cancels], [...states]);
      await cancelWithOutcome(port, ID);
      expect(forgotten).toEqual([]);
    }
  });

  test('a port without the method still reports the outcome', async () => {
    const port: CancelPort = { cancel: async () => false, getJobState: async () => 'unknown' };
    expect(await cancelWithOutcome(port, ID)).toEqual({ removed: false, state: 'unknown' });
  });
});

/** Make `m.getJobState` deliver the job's ACK first, once (instance override). */
function ackBeforeFirstStateRead(m: QueueManager, id: JobId, result: unknown): void {
  const read = m.getJobState.bind(m);
  let acked = false;
  m.getJobState = async (target: JobId) => {
    if (!acked) {
      acked = true;
      await m.ack(id, result);
    }
    return read(target);
  };
}

/** Push and pull one job removed on completion; returns its ID (active). */
async function activeRemovedOnComplete(m: QueueManager, queue: string): Promise<JobId> {
  await m.push(queue, { data: {}, removeOnComplete: true });
  const pulled = await m.pull(queue);
  expect(pulled).not.toBeNull();
  return pulled!.id;
}

function context(qm: QueueManager): HandlerContext {
  return { queueManager: qm, authTokens: new Set(), authenticated: false, clientId: 'cfr' };
}

const gone = { found: false, result: undefined };

describe('every Cancel transport drops the record of a job it reports missing', () => {
  test('TCP Cancel answers the legacy not-found reply and leaves no result', async () => {
    manager = new QueueManager();
    const id = await activeRemovedOnComplete(manager, 'cfr-tcp');
    ackBeforeFirstStateRead(manager, id, { n: 1 });

    expect(await handleCancel({ cmd: 'Cancel', id }, context(manager))).toMatchObject({
      ok: false,
      error: CANCEL_JOB_NOT_FOUND_ERROR,
    });
    expect(await manager.getCompletionAsync(id)).toEqual(gone);
  });

  test('HTTP DELETE /jobs/:id answers the same and leaves no result', async () => {
    manager = new QueueManager();
    const id = await activeRemovedOnComplete(manager, 'cfr-http');
    ackBeforeFirstStateRead(manager, id, { n: 2 });

    const path = `/jobs/${id}`;
    const request = new Request(`http://localhost${path}`, { method: 'DELETE' });
    const response = await routeJobRoutes(request, path, 'DELETE', context(manager), new Set());
    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({ ok: false, error: CANCEL_JOB_NOT_FOUND_ERROR });
    expect(await manager.getCompletionAsync(id)).toEqual(gone);
  });

  test('embedded removeAsync() resolves and leaves no result', async () => {
    const shared = getSharedManager();
    const id = await activeRemovedOnComplete(shared, `cfr-embedded-${crypto.randomUUID()}`);
    ackBeforeFirstStateRead(shared, id, { n: 3 });

    await expect(removeJob(true, null, String(id))).resolves.toBeUndefined();
    expect(await shared.getCompletionAsync(id)).toEqual(gone);
  });

  test('a refusal naming active keeps the result of the later completion', async () => {
    manager = new QueueManager();
    const id = await activeRemovedOnComplete(manager, 'cfr-active');

    expect(await cancelWithOutcome(manager, id)).toEqual({ removed: false, state: 'active' });
    await manager.ack(id, { n: 4 });
    expect(await manager.getCompletionAsync(id)).toEqual({ found: true, result: { n: 4 } });
  });
});
