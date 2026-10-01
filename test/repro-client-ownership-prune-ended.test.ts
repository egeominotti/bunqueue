/**
 * Repro: the periodic ownership prune kept records whose delivery had ended.
 *
 * pruneEndedClientDeliveries kept any record where `jobIndex.get(id) ===
 * owner.delivery`. A registration that runs after its delivery ended records
 * `undefined` (the job left jobIndex) or a non-processing location (the job
 * completed), and that comparison then stays true forever, so the record
 * survived every cleanup pass until the connection closed. Only a live
 * processing delivery may keep its record.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { cleanup } from '../src/application/cleanupTasks';
import type { BackgroundContext } from '../src/application/types';

function backgroundContext(qm: QueueManager): BackgroundContext {
  return (
    qm as unknown as { contextFactory: { getBackgroundContext(): BackgroundContext } }
  ).contextFactory.getBackgroundContext();
}

let qm: QueueManager | undefined;

afterEach(() => {
  qm?.shutdown();
  qm = undefined;
});

describe('the ownership prune drops records of ended deliveries', () => {
  test('a registration after the job left jobIndex is pruned', async () => {
    qm = new QueueManager();
    const ctx = backgroundContext(qm);
    await qm.push('prune-removed', { data: {}, removeOnComplete: true });
    const pulled = await qm.pullWithLock('prune-removed', 'worker', 0, 60_000);
    const id = pulled.job!.id;
    await qm.ack(id, undefined, pulled.token!);
    expect(ctx.jobIndex.has(id)).toBe(false);

    qm.registerClientJob('client-1', id); // arrives after the delivery ended
    await cleanup(ctx);

    expect(ctx.clientJobOwners.has(id)).toBe(false);
    expect(ctx.clientJobs.get('client-1')?.has(id) ?? false).toBe(false);
  });

  test('a registration after the job completed is pruned', async () => {
    qm = new QueueManager();
    const ctx = backgroundContext(qm);
    await qm.push('prune-completed', { data: {} });
    const pulled = await qm.pullWithLock('prune-completed', 'worker', 0, 60_000);
    const id = pulled.job!.id;
    await qm.ack(id, undefined, pulled.token!);
    expect(ctx.jobIndex.get(id)?.type).not.toBe('processing');

    qm.registerClientJob('client-1', id);
    await cleanup(ctx);

    expect(ctx.clientJobOwners.has(id)).toBe(false);
    expect(ctx.clientJobs.get('client-1')?.has(id) ?? false).toBe(false);
  });

  test('a live delivery keeps its record', async () => {
    qm = new QueueManager();
    const ctx = backgroundContext(qm);
    await qm.push('prune-live', { data: {} });
    const pulled = await qm.pullWithLock('prune-live', 'worker', 0, 60_000);
    const id = pulled.job!.id;

    qm.registerClientJob('client-1', id);
    await cleanup(ctx);

    expect(ctx.clientJobOwners.get(id)?.clientId).toBe('client-1');
    expect(await qm.releaseClientJobs('client-1')).toBe(1);
  });
});
