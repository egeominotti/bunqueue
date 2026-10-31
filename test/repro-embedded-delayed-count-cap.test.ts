/**
 * Repro: in embedded mode `queue.getDelayedCount()` counted the jobs of one default
 * `getJobs` page (end = 100), so a queue holding 250 delayed jobs reported 100 while
 * `getJobCountsAsync().delayed` (and the TCP path, which reads `GetJobCounts`)
 * reported 250.
 */
import { afterEach, expect, test } from 'bun:test';
import { Queue, shutdownManager } from '../src/client';

let queue: Queue | null = null;

afterEach(async () => {
  await queue?.obliterateAsync().catch(() => undefined);
  await queue?.close();
  queue = null;
  shutdownManager();
});

test('embedded getDelayedCount counts every delayed job, not one page', async () => {
  queue = new Queue(`repro-delayed-count-${process.pid}`, { embedded: true });
  for (const total of [100, 101, 250]) {
    await queue.obliterateAsync();
    await queue.addBulk(
      Array.from({ length: total }, (_, index) => ({
        name: 'later',
        data: { index },
        opts: { delay: 600_000 },
      }))
    );
    expect((await queue.getJobCountsAsync()).delayed).toBe(total);
    expect(await queue.getDelayedCount()).toBe(total);
  }
});
