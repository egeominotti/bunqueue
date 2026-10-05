/**
 * Repro (2.9.10 compatibility): the `bunqueue/queue` QueueManager API.
 *
 * - `pull`/`pullWithLock` with a timeout above 60 s or below 0 threw; 2.9.10 waited
 *   the full time (or did not wait). They must do the same again.
 * - `pullWithLock` with `lockTtl` 0 threw; 2.9.10 granted the lease and the job could be
 *   acknowledged with its token.
 * - `changePriority(id, 2097152)` threw while `push` with the same priority succeeded;
 *   both must accept it, as 2.9.10 did.
 * - `updateProgress`, `changeDelay`, `clearLogs` and `updateJobData` apply the same
 *   2.9.10 results as the TCP commands.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { jobId } from '../src/domain/types/job';

let manager: QueueManager | null = null;

afterEach(() => {
  manager?.shutdown();
  manager = null;
});

async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

describe('QueueManager keeps the 2.9.10 argument results', () => {
  test('pull timeouts outside 0..60000 are accepted, as 2.9.10 did', async () => {
    manager = new QueueManager();
    const qm = manager;
    await qm.push('qm-pull', { name: 'a', data: {} });
    await qm.push('qm-pull', { name: 'b', data: {} });
    const results = {
      'pull 120000': await outcome(qm.pull('qm-pull', 120_000)),
      'pullWithLock 61000': await outcome(qm.pullWithLock('qm-pull', 'w', 61_000)),
      'pull -1': await outcome(qm.pull('qm-pull', -1)),
      'pullBatch -1': await outcome(qm.pullBatch('qm-pull', 2, -1)),
    };
    expect(results).toEqual({
      'pull 120000': 'ok',
      'pullWithLock 61000': 'ok',
      'pull -1': 'ok',
      'pullBatch -1': 'ok',
    });
  });

  test('pullWithLock with lockTtl 0 grants a lease the job can be acknowledged with', async () => {
    manager = new QueueManager();
    await manager.push('qm-lock', { name: 'a', data: {} });
    const { job, token } = await manager.pullWithLock('qm-lock', 'w', 0, 0);
    expect(job).not.toBeNull();
    await manager.ack(job!.id, { ok: true }, token ?? undefined);
    expect(await manager.getJobState(job!.id)).toBe('completed');
  });

  test('push and changePriority agree on priority 2097152', async () => {
    manager = new QueueManager();
    const job = await manager.push('qm-prio', { name: 'a', data: {}, priority: 5 });
    await expect(manager.changePriority(job.id, 2_097_152)).resolves.toBe(true);
    expect((await manager.getJob(job.id))?.priority).toBe(2_097_152);
    const pushed = await manager.push('qm-prio', { name: 'b', data: {}, priority: 2_097_152 });
    expect(pushed.priority).toBe(2_097_152);
  });

  test('progress, delay, logs and data setters', async () => {
    manager = new QueueManager();
    const qm = manager;
    await qm.push('qm-set', { name: 'a', data: {} });
    const { job } = await qm.pullWithLock('qm-set', 'w', 0);
    const id = job!.id;
    await qm.updateProgress(id, '40' as unknown as number);
    expect(qm.getProgress(id)?.progress).toBe(40);
    for (const line of ['a', 'b', 'c']) qm.addLog(id, line);
    qm.clearLogs(id, -1);
    expect(qm.getLogs(id)).toHaveLength(0);
    const delayed = await qm.push('qm-set', { name: 'b', data: {}, delay: 60_000 });
    await expect(qm.changeDelay(delayed.id, -1)).resolves.toBe(true);
    expect(await qm.getJobState(delayed.id)).toBe('waiting');
    await expect(
      qm.updateJobData(jobId(String(delayed.id)), { blob: 'x'.repeat(11 * 1024 * 1024) })
    ).resolves.toBe(true);
  });
});
