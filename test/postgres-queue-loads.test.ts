/**
 * PostgresQueueLoads (issue #161): which jobs a full-queue read model leaves alone, and
 * which read models it drops. No database is needed.
 */
import { describe, expect, test } from 'bun:test';
import { PostgresQueueLoads } from '../src/application/postgres-queue-manager/queueLoads';
import { jobId, type JobId } from '../src/domain/types/job';

const HORIZON = 10;

function deferredMap<T extends object>() {
  let resolve!: (value: ReadonlyMap<JobId, T>) => void;
  const promise = new Promise<ReadonlyMap<JobId, T>>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe('PostgreSQL full-queue load fences', () => {
  test('keeps a job changed after the horizon by an event or a local change', () => {
    const loads = new PostgresQueueLoads();
    const fence = loads.begin('orders');
    loads.jobChanged('orders', jobId('held-event'), HORIZON);
    loads.jobChanged('orders', jobId('later-event'), HORIZON + 1);
    loads.jobChanged('orders', jobId('own-write'));
    loads.jobChanged('invoices', jobId('other-queue'));
    loads.jobChanged(undefined, jobId('no-queue'));

    expect(fence.changedAfter(jobId('held-event'), HORIZON)).toBe(false);
    expect(fence.changedAfter(jobId('later-event'), HORIZON)).toBe(true);
    expect(fence.changedAfter(jobId('own-write'), HORIZON)).toBe(true);
    expect(fence.changedAfter(jobId('other-queue'), HORIZON)).toBe(false);
    expect(fence.changedAfter(jobId('no-queue'), HORIZON)).toBe(false);
    expect(fence.changedAfter(jobId('untouched'), HORIZON)).toBe(false);

    loads.end(fence);
    loads.jobChanged('orders', jobId('after-end'));
    expect(fence.changedAfter(jobId('after-end'), HORIZON)).toBe(false);
  });

  test('keeps a job only for a projection whose load started after the load began', async () => {
    const loads = new PostgresQueueLoads();
    const older = { row: null };
    const newer = { row: null };
    const pending = deferredMap<typeof older>();
    const olderLoad = loads.loadProjections(() => pending.promise);
    const fence = loads.begin('orders');
    await loads.loadProjections(async () => new Map([[jobId('newer'), newer]]));
    pending.resolve(new Map([[jobId('older'), older]]));
    await olderLoad;

    loads.projectionInstalled(['orders'], jobId('older'), older);
    loads.projectionInstalled([undefined, 'orders', 'orders'], jobId('newer'), newer);
    loads.projectionInstalled(['orders'], jobId('unloaded'), { row: null });

    // An older projection may predate a drain that journaled no per-job event.
    expect(fence.changedAfter(jobId('older'), HORIZON)).toBe(false);
    expect(fence.changedAfter(jobId('newer'), HORIZON)).toBe(true);
    expect(fence.changedAfter(jobId('unloaded'), HORIZON)).toBe(false);
  });

  test('drops a read model older than one installed while it loaded', () => {
    const loads = new PostgresQueueLoads();
    const older = loads.begin('orders');
    const newer = loads.begin('orders');
    expect(loads.claim(newer, HORIZON + 1)).toBe('install');
    loads.end(newer);
    // It began before the installed one, which holds everything it holds.
    expect(loads.claim(older, HORIZON)).toBe('drop');
    loads.end(older);

    const same = loads.begin('orders');
    const again = loads.begin('orders');
    expect(loads.claim(same, HORIZON)).toBe('install');
    expect(loads.claim(again, HORIZON)).toBe('install');
    loads.end(same);
    loads.end(again);
  });

  test('reloads a dropped read model whose load began after the installed one', () => {
    const loads = new PostgresQueueLoads();
    // The first load takes its snapshot last: it installs with the higher horizon, keeping
    // jobs recorded since it began, perhaps one a drain then deleted.
    const first = loads.begin('orders');
    const second = loads.begin('orders');
    expect(loads.claim(first, HORIZON + 1)).toBe('install');
    loads.end(first);
    // The second load may have been started by that drain's invalidation.
    expect(loads.claim(second, HORIZON)).toBe('reload');
    loads.end(second);
  });

  test('forgets a queue once no load of it is in flight', () => {
    const loads = new PostgresQueueLoads();
    const first = loads.begin('orders');
    const second = loads.begin('orders');
    expect(loads.claim(first, HORIZON)).toBe('install');
    loads.end(first);
    expect(Reflect.get(loads, 'installed').size).toBe(1);
    loads.end(second);
    expect(Reflect.get(loads, 'installed').size).toBe(0);
    expect(Reflect.get(loads, 'loading').size).toBe(0);

    // Every later load starts after that install: nothing older is left to drop.
    const later = loads.begin('orders');
    expect(loads.claim(later, 0)).toBe('install');
    loads.end(later);
    expect(Reflect.get(loads, 'installed').size).toBe(0);
  });
});
