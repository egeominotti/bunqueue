/**
 * Engine-level tests of the removed-result retention (issue #155 A): every completion
 * path that removes a job on completion records its result in memory, the completion
 * lookup answers from it while no current generation holds the ID, and a new
 * generation, a remove (Cancel), an obliterate, the TTL and shutdown drop it. GetResult
 * and GetState keep their previous answers. See src/application/removedResults.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import type { RemovedResults } from '../src/application/removedResults';
import { managerReader } from '../src/client/job-wait/readers';
import { getSharedManager, shutdownManager } from '../src/client/manager';
import { CANCEL_JOB_NOT_FOUND_ERROR } from '../src/domain/job/cancellation';
import { jobId, type JobId } from '../src/domain/types/job';
import { handleCommand } from '../src/infrastructure/server/handler';
import type { HandlerContext } from '../src/infrastructure/server/types';
import { EmbeddedBackend } from '../src/mcp/backend/embedded';

let qm: QueueManager | null = null;

afterEach(() => {
  qm?.shutdown();
  qm = null;
  shutdownManager();
});

function context(manager: QueueManager): HandlerContext {
  return { queueManager: manager, authTokens: new Set<string>(), authenticated: false };
}

const retained = (manager: QueueManager): number => manager.getMemoryStats().removedResults;

/** Push, pull and ACK one job removed on completion; returns its ID. */
async function completeRemoved(
  manager: QueueManager,
  queue: string,
  result: unknown,
  customId?: string
): Promise<JobId> {
  await manager.push(queue, { data: {}, removeOnComplete: true, customId });
  const pulled = await manager.pull(queue);
  if (!pulled) throw new Error('no job pulled');
  await manager.ack(pulled.id, result);
  return pulled.id;
}

describe('recording', () => {
  test('a single ACK: the lookup answers, GetState and GetResult are unchanged', async () => {
    qm = new QueueManager();
    const id = await completeRemoved(qm, 'rr-single', { answer: 42 });

    expect(await qm.getCompletionAsync(id)).toEqual({ found: true, result: { answer: 42 } });
    expect(await qm.getJobState(id)).toBe('unknown');
    expect(await qm.getJob(id)).toBeNull();
    expect(await qm.getResultAsync(id)).toBeUndefined();
    expect(retained(qm)).toBe(1);
  });

  test('a batch ACK (finalizeBatchAck) records each result; ACKB without results records undefined', async () => {
    qm = new QueueManager();
    for (let n = 0; n < 12; n++) await qm.push('rr-batch', { data: { n }, removeOnComplete: true });
    const first = await qm.pullBatch('rr-batch', 6);
    const second = await qm.pullBatch('rr-batch', 6);

    await qm.ackBatchWithResults(first.map((job, n) => ({ id: job.id, result: { n } })));
    await qm.ackBatch(second.map((job) => job.id));

    for (const [n, job] of first.entries()) {
      expect(await qm.getCompletionAsync(job.id)).toEqual({ found: true, result: { n } });
    }
    for (const job of second) {
      expect(await qm.getCompletionAsync(job.id)).toEqual({ found: true, result: undefined });
    }
    expect(retained(qm)).toBe(12);
  });

  test('a batch ACK reads the clock once; disabled, it does no record work at all', async () => {
    for (const retentionMs of [60_000, 0]) {
      qm = new QueueManager({ removedResultRetentionMs: retentionMs });
      for (let n = 0; n < 8; n++)
        await qm.push('rr-stamp', { data: { n }, removeOnComplete: true });
      const jobs = await qm.pullBatch('rr-stamp', 8);
      const store = (qm as unknown as { removedResults: RemovedResults }).removedResults;
      const calls = { now: 0, record: 0 };
      const now = store.now.bind(store);
      const record = store.record.bind(store);
      store.now = () => (calls.now++, now());
      store.record = (...args) => (calls.record++, record(...args));

      await qm.ackBatchWithResults(jobs.map((job, n) => ({ id: job.id, result: { n } })));

      expect(calls).toEqual(retentionMs > 0 ? { now: 1, record: 8 } : { now: 0, record: 0 });
      expect(retained(qm)).toBe(retentionMs > 0 ? 8 : 0);
      qm.shutdown();
    }
  });

  test('a stall-retried job completed by a late ACK', async () => {
    qm = new QueueManager();
    await qm.push('rr-stall', { data: {}, removeOnComplete: true, maxAttempts: 3, backoff: 0 });
    const pulled = await qm.pull('rr-stall');
    await qm.fail(pulled!.id, 'transient');
    expect(await qm.getJobState(pulled!.id)).toBe('waiting');

    await qm.ack(pulled!.id, 'late');

    expect(await qm.getCompletionAsync(pulled!.id)).toEqual({ found: true, result: 'late' });
  });

  test('a job kept on completion is not recorded', async () => {
    qm = new QueueManager();
    await qm.push('rr-kept', { data: {} });
    const pulled = await qm.pull('rr-kept');
    await qm.ack(pulled!.id, 'kept');

    expect(retained(qm)).toBe(0);
    expect(await qm.getCompletionAsync(pulled!.id)).toEqual({ found: true, result: 'kept' });
  });

  test('a TTL of 0 disables the retention', async () => {
    qm = new QueueManager({ removedResultRetentionMs: 0 });
    const id = await completeRemoved(qm, 'rr-off', 'gone');

    expect(retained(qm)).toBe(0);
    expect(await qm.getCompletionAsync(id)).toEqual({ found: false, result: undefined });
  });
});

describe('invalidation', () => {
  test('a new generation under the same custom ID drops the record (PUSH and PUSHB)', async () => {
    qm = new QueueManager();
    const id = await completeRemoved(qm, 'rr-reuse', 'first', 'same-id');
    await qm.pushBatch('rr-reuse-batch', [
      { data: {}, removeOnComplete: true, customId: 'batch-id' },
    ]);
    const batchJob = await qm.pull('rr-reuse-batch');
    await qm.ack(batchJob!.id, 'batch-first');
    expect(retained(qm)).toBe(2);

    await qm.push('rr-reuse', { data: {}, customId: 'same-id' });
    await qm.pushBatch('rr-reuse-batch', [{ data: {}, customId: 'batch-id' }]);

    expect(retained(qm)).toBe(0);
    expect(await qm.getJobState(id)).toBe('waiting');
    expect(await qm.getCompletionAsync(id)).toEqual({ found: false, result: undefined });
    // Removing the new generation must not resurrect the old result.
    expect(await qm.cancel(id)).toBe(true);
    expect(await qm.getCompletionAsync(id)).toEqual({ found: false, result: undefined });
  });

  test('a record never answers while a current generation holds the ID', async () => {
    qm = new QueueManager();
    const live = await qm.push('rr-guard', { data: {}, customId: 'live-id' });
    // Defense in depth: even a record the admission did not drop is not served.
    const internals = qm as unknown as { removedResults: RemovedResults };
    internals.removedResults.record(live.id, 'rr-guard', 'stale');

    expect(await qm.getCompletionAsync(live.id)).toEqual({ found: false, result: undefined });
  });

  test('a flow job admitted under the ID drops the record', async () => {
    // A one-entry completion window lets the flow reuse the ID once its proof is evicted.
    qm = new QueueManager({ maxCompletedJobs: 1 });
    const id = await completeRemoved(qm, 'rr-flow', 'first', 'flow-id');
    await completeRemoved(qm, 'rr-flow', 'other');
    expect(retained(qm)).toBe(2);

    await qm.pushFlow({ jobs: [{ id, queue: 'rr-flow', input: { data: {} } }] });

    expect(retained(qm)).toBe(1);
    expect(await qm.getCompletionAsync(id)).toEqual({ found: false, result: undefined });
  });

  test('Cancel drops the record and still answers the legacy not-found reply', async () => {
    qm = new QueueManager();
    const id = await completeRemoved(qm, 'rr-cancel', 'secret');

    const reply = await handleCommand({ cmd: 'Cancel', id: String(id) }, context(qm));

    expect(reply).toMatchObject({ ok: false, error: CANCEL_JOB_NOT_FOUND_ERROR });
    expect(retained(qm)).toBe(0);
    expect(await qm.getCompletionAsync(id)).toEqual({ found: false, result: undefined });
  });

  test("obliterate drops the queue's records only", async () => {
    qm = new QueueManager();
    const gone = await completeRemoved(qm, 'rr-obliterate', 'secret');
    const kept = await completeRemoved(qm, 'rr-other', 'other');

    qm.obliterate('rr-obliterate');

    expect(await qm.getCompletionAsync(gone)).toEqual({ found: false, result: undefined });
    expect(await qm.getCompletionAsync(kept)).toEqual({ found: true, result: 'other' });
  });

  test('the periodic cleanup purges expired records without new completions', async () => {
    qm = new QueueManager({ removedResultRetentionMs: 30, cleanupIntervalMs: 20 });
    await completeRemoved(qm, 'rr-ttl', 'short-lived');
    expect(retained(qm)).toBe(1);

    for (let waited = 0; retained(qm) > 0 && waited < 3_000; waited += 10) await Bun.sleep(10);

    expect(retained(qm)).toBe(0);
  });

  test('shutdown clears the records', async () => {
    qm = new QueueManager();
    await completeRemoved(qm, 'rr-shutdown', 'secret');

    qm.shutdown();

    expect(retained(qm)).toBe(0);
  });
});

describe('readers', () => {
  test('WaitJob answers with the retained result', async () => {
    qm = new QueueManager();
    const id = await completeRemoved(qm, 'rr-waitjob', { answer: 7 });

    expect(
      await handleCommand({ cmd: 'WaitJob', id: String(id), timeout: 0 }, context(qm))
    ).toMatchObject({ ok: true, completed: true, result: { answer: 7 } });
  });

  test('the embedded wait reader settles on the retained result, then on missing', async () => {
    shutdownManager();
    const manager = getSharedManager();
    const id = await completeRemoved(manager, 'rr-reader', { answer: 9 });
    const reader = managerReader(manager, String(id));

    expect(await reader.read()).toEqual({ value: { answer: 9 } });

    await manager.cancel(id);

    const missing = await reader.read();
    expect(missing).toMatchObject({ missing: true });
    expect((missing as { error: Error }).error.message).toBe(`Job ${id} not found`);
  });

  test('the MCP embedded wait reports a retained completion as completed', async () => {
    shutdownManager();
    const backend = new EmbeddedBackend();
    const manager = getSharedManager();
    const id = await completeRemoved(manager, 'rr-mcp', 'done');

    expect(await backend.waitForJobCompletion(String(id), 1_000)).toBe(true);
    await expect(backend.waitForJobCompletion('never-existed', 1_000)).rejects.toThrow(
      'Job not found'
    );
    expect(jobId(String(id))).toBe(id);
  });
});
