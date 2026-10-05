/**
 * Issue #73: Cron job fires immediately on client reconnect
 *
 * Reproduces the exact scenario reported by @arthurvanl:
 * 1. Cron `* * * * *` fires, job pushed with preventOverlap
 * 2. Worker pulls job (active state, owned by clientId)
 * 3. Client disconnects (SIGINT / TCP close)
 * 4. releaseClientJobs re-queues the cron job back to "waiting"
 * 5. New client connects → worker pulls the waiting cron job immediately
 *
 * Root cause: releaseClientJobs re-queues ALL active jobs, including
 * cron jobs with preventOverlap. These should be discarded instead,
 * because the cron scheduler will push a new one at the next tick.
 *
 * @see https://github.com/egeominotti/bunqueue/issues/73
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync, existsSync } from 'fs';
import { QueueManager } from '../src/application/queueManager';

const TEST_DB_PATH = join(tmpdir(), `bunqueue-issue73-disconnect-${Date.now()}.db`);

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = TEST_DB_PATH + suffix;
    if (existsSync(p)) {
      try { unlinkSync(p); } catch {}
    }
  }
}

/** Flush the write buffer so all jobs are persisted to SQLite */
function flushStorage(manager: QueueManager): void {
  const storage = (manager as any).storage;
  if (storage) storage.flushWriteBuffer();
}

describe('Issue #73: cron job re-queued on client disconnect', () => {
  afterEach(cleanup);

  test('releaseClientJobs discards cron jobs with preventOverlap', async () => {
    const manager = new QueueManager({ dataPath: TEST_DB_PATH });
    const queueName = 'testing';
    const clientId = 'test-client-1';

    // Add cron with preventOverlap (default: true)
    manager.addCron({
      name: 'start-new-test-job',
      queue: queueName,
      data: { type: 'test' },
      schedule: '* * * * *',
    });

    // Force the cron to fire
    const scheduler = (manager as any).cronScheduler;
    const cronEntry = scheduler.cronJobs.get('start-new-test-job');
    cronEntry.cron.nextRun = Date.now() - 1000;
    scheduler.cronHeap.buildFrom(
      Array.from(scheduler.cronJobs.values()).map((e: any) => ({
        cron: e.cron,
        generation: e.generation,
      }))
    );
    (scheduler as any).lastFiredAt.clear();
    await (scheduler as any).tick();
    flushStorage(manager);

    // Worker pulls job (simulating TCP worker ownership; ownership is registered below).
    // The second argument of pull() is the long-poll timeout, validated like TCP PULL,
    // so the clientId is not passed there.
    const job = await manager.pull(queueName);
    expect(job).not.toBeNull();
    expect(job!.uniqueKey).toBe('cron:start-new-test-job');

    // Register client-job ownership (done by TCP/WS handler on pull)
    manager.registerClientJob(clientId, job!.id);

    // Verify job is active
    const countsBefore = manager.getQueueJobCounts(queueName);
    expect(countsBefore.active).toBe(1);
    expect(countsBefore.waiting).toBe(0);

    // Client disconnects → releaseClientJobs should DISCARD cron job, not re-queue
    const released = await manager.releaseClientJobs(clientId);
    expect(released).toBe(1);

    // Queue should be EMPTY — cron job discarded, not re-queued
    const countsAfter = manager.getQueueJobCounts(queueName);
    expect(countsAfter.waiting).toBe(0);
    expect(countsAfter.active).toBe(0);

    // A new worker connecting should NOT find any job
    const pulledAfter = await manager.pull(queueName);
    expect(pulledAfter).toBeNull();

    manager.shutdown();
  });

  test('releaseClientJobs still re-queues normal jobs on disconnect', async () => {
    const manager = new QueueManager({ dataPath: TEST_DB_PATH });
    const queueName = 'normal-queue';
    const clientId = 'test-client-2';

    // Push a normal job
    await manager.push(queueName, { data: { type: 'payment' } });
    flushStorage(manager);

    // Worker pulls with clientId
    const job = await manager.pull(queueName);
    expect(job).not.toBeNull();
    expect(job!.uniqueKey).toBeNull();

    // Register client-job ownership
    manager.registerClientJob(clientId, job!.id);

    // Client disconnects → normal job should be re-queued
    const released = await manager.releaseClientJobs(clientId);
    expect(released).toBe(1);

    // Job should be back in the queue (waiting)
    const counts = manager.getQueueJobCounts(queueName);
    expect(counts.waiting).toBe(1);

    // Another worker can pick it up
    const repulled = await manager.pull(queueName);
    expect(repulled).not.toBeNull();
    expect(repulled!.id).toBe(job!.id);

    manager.shutdown();
  });

  test('upsert removes orphaned cron job from queue (#73 code path 6)', async () => {
    const manager = new QueueManager({ dataPath: TEST_DB_PATH });
    const queueName = 'testing';

    // Add cron with preventOverlap
    manager.addCron({
      name: 'start-new-test-job',
      queue: queueName,
      data: { type: 'test' },
      schedule: '* * * * *',
      preventOverlap: true,
      skipIfNoWorker: true,
    });

    // Force the cron to fire (simulates tick between disconnect and reconnect)
    const scheduler = (manager as any).cronScheduler;
    const cronEntry = scheduler.cronJobs.get('start-new-test-job');
    cronEntry.cron.nextRun = Date.now() - 1000;
    scheduler.cronHeap.buildFrom(
      Array.from(scheduler.cronJobs.values()).map((e: any) => ({
        cron: e.cron,
        generation: e.generation,
      }))
    );
    (scheduler as any).lastFiredAt.clear();

    // Temporarily make hasWorkers return true (simulates stale worker within 30s timeout)
    const origHasWorkers = scheduler.hasWorkers;
    scheduler.hasWorkers = () => true;
    await (scheduler as any).tick();
    scheduler.hasWorkers = origHasWorkers;
    flushStorage(manager);

    // Job is now sitting in queue with uniqueKey 'cron:start-new-test-job'
    const countsBefore = manager.getQueueJobCounts(queueName);
    expect(countsBefore.waiting).toBe(1);

    // Client reconnects and calls upsertJobScheduler (addCron) again
    // This should remove the orphaned job before creating the cron
    manager.addCron({
      name: 'start-new-test-job',
      queue: queueName,
      data: { type: 'test' },
      schedule: '* * * * *',
      preventOverlap: true,
      skipIfNoWorker: true,
    });

    // Queue should be EMPTY — orphaned job removed by upsert
    const countsAfter = manager.getQueueJobCounts(queueName);
    expect(countsAfter.waiting).toBe(0);

    // A worker connecting should NOT find any job
    const pulled = await manager.pull(queueName);
    expect(pulled).toBeNull();

    manager.shutdown();
  });

  test('releaseClientJobs re-queues cron jobs WITHOUT preventOverlap', async () => {
    const manager = new QueueManager({ dataPath: TEST_DB_PATH });
    const queueName = 'cron-no-overlap';
    const clientId = 'test-client-3';

    // Add cron WITHOUT preventOverlap (no 'cron:' uniqueKey)
    manager.addCron({
      name: 'no-overlap-cron',
      queue: queueName,
      data: { type: 'test' },
      schedule: '* * * * *',
      preventOverlap: false,
    });

    // Push job manually (simulating cron fire without uniqueKey)
    await manager.push(queueName, { data: { tick: 1 } });
    flushStorage(manager);

    // Worker pulls with clientId
    const job = await manager.pull(queueName);
    expect(job).not.toBeNull();
    expect(job!.uniqueKey).toBeNull();

    // Register client-job ownership
    manager.registerClientJob(clientId, job!.id);

    // Client disconnects → job should be re-queued (no 'cron:' prefix)
    await manager.releaseClientJobs(clientId);

    const counts = manager.getQueueJobCounts(queueName);
    expect(counts.waiting).toBe(1);

    manager.shutdown();
  });
});
