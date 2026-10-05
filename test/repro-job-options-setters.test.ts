/**
 * Repro: job setters stored unvalidated values that reach ordering or storage.
 *
 * - `ChangePriority` / `changePriority` accepted any priority: NaN broke the heap
 *   comparator (`b.priority - a.priority` is NaN) and was persisted as is. A non-boolean
 *   `lifo` was stored on the heap entry, where `1` and `true` each sort before the other;
 *   it is now normalized to a boolean, as PUSH does. Every finite priority (fractional,
 *   above 1,000,000, a grouped job's -1) is applied and a missing one is 0, as on 2.9.10
 *   (repro-compat-job-wire.test.ts, repro-compat-job-priority-backoff.test.ts).
 * - `Progress` / `updateProgress(NaN)` stored NaN (`Math.max(0, Math.min(100, NaN))`); it
 *   now stores 0 without failing the processor, as 2.9.10 completed the job.
 * - `Update` / `updateData` accepts any serializable payload, as on 2.9.10.
 * - A PUSH with a non-boolean `lifo` (e.g. `1`) broke the same comparator.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { jobId } from '../src/domain/types/job';
import { COMMANDS } from '../src/infrastructure/cloud/commands';
import { LocalCloudQueueAdapter } from '../src/infrastructure/cloud/queueAdapter/local';
import type { CloudCommand } from '../src/infrastructure/cloud/types/command';
import { CoreE2eHarness, type CoreE2eMode } from './core-e2e/support/harness';

let harness: CoreE2eHarness | null = null;
let manager: QueueManager | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
  manager?.shutdown();
  manager = null;
});

async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    return `value: ${String(await promise)}`;
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const TOO_LARGE = { blob: 'x'.repeat(10 * 1024 * 1024) };

describe.each(['embedded', 'tcp'] as const)('job setters (%s)', (mode: CoreE2eMode) => {
  test('changeJobPriority applies every finite priority and refuses NaN', async () => {
    harness = await CoreE2eHarness.start(mode, 'setters-priority');
    const queue = harness.queue('setters-priority');
    const plain = await queue.add('plain', {}, { priority: 5 });
    const grouped = await queue.add('grouped', {}, { group: { id: 'g', priority: 3 } });
    const results = {
      nan: await outcome(queue.changeJobPriority(plain.id, { priority: Number.NaN })),
      fraction: await outcome(queue.changeJobPriority(plain.id, { priority: 1.5 })),
      tooHigh: await outcome(queue.changeJobPriority(plain.id, { priority: 2_000_000 })),
      badLifo: await outcome(
        queue.changeJobPriority(plain.id, { priority: 1, lifo: 1 as unknown as boolean })
      ),
      groupNegative: await outcome(queue.changeJobPriority(grouped.id, { priority: -1 })),
      groupValid: await outcome(queue.changeJobPriority(grouped.id, { priority: 2_000_000 })),
      plainValid: await outcome(queue.changeJobPriority(plain.id, { priority: -1_000_000 })),
    };
    expect(results).toEqual({
      nan: 'error: priority must be a finite number',
      fraction: 'value: undefined',
      tooHigh: 'value: undefined',
      badLifo: 'value: undefined',
      groupNegative: 'value: undefined',
      groupValid: 'value: undefined',
      plainValid: 'value: undefined',
    });
    expect((await queue.getJob(plain.id))?.priority).toBe(-1_000_000);
    // `lifo: 1` was applied as `true`, as PUSH normalizes it (2.9.10 applied it too).
    expect((await harness.brokerManager().getJob(jobId(String(plain.id))))?.lifo).toBe(true);
  });

  test('a Worker job stores a NaN progress as 0 and any updateData size', async () => {
    harness = await CoreE2eHarness.start(mode, 'setters-worker');
    const queue = harness.queue('setters-worker');
    await queue.add('task', {});
    const results = await new Promise<Record<string, string>>((resolve) => {
      harness!.worker(queue.name, async (job) => {
        resolve({
          progressNaN: await outcome(job.updateProgress(Number.NaN)),
          progressValid: await outcome(job.updateProgress(40)),
          tooLarge: await outcome(job.updateData(TOO_LARGE)),
        });
        return 'done';
      });
    });
    expect(results).toEqual({
      progressNaN: 'value: undefined',
      progressValid: 'value: undefined',
      tooLarge: 'value: undefined',
    });
  }, 30_000);
});

describe('engine entry points', () => {
  test('QueueManager setters give the TCP command results', async () => {
    manager = new QueueManager();
    const job = await manager.push('setters-engine', { data: {}, priority: 2 });
    await expect(manager.changePriority(job.id, Number.NaN)).rejects.toThrow(
      'priority must be a finite number'
    );
    await expect(manager.updateJobData(job.id, TOO_LARGE)).resolves.toBe(true);
    await manager.push('setters-progress', { data: {} });
    const active = await manager.pull('setters-progress');
    await manager.updateProgress(active!.id, 30);
    await expect(manager.updateProgress(active!.id, Number.NaN)).resolves.toBe(true);
    expect(manager.getProgress(active!.id)?.progress).toBe(0);
    expect((await manager.getJob(job.id))?.priority).toBe(2);
  });

  test('Cloud job:priority refuses NaN and applies a missing priority as 0', async () => {
    manager = new QueueManager();
    const job = await manager.push('setters-cloud', { data: {}, priority: 7 });
    const adapter = new LocalCloudQueueAdapter(manager);
    const run = (command: Partial<CloudCommand>) =>
      outcome(COMMANDS['job:priority']!(adapter, { id: 'c', ...command } as CloudCommand));
    expect(await run({ jobId: String(job.id), priority: Number.NaN })).toBe(
      'error: priority must be a finite number'
    );
    expect((await manager.getJob(job.id))?.priority).toBe(7);
    await run({ jobId: String(job.id), priority: 1.5 });
    expect((await manager.getJob(job.id))?.priority).toBe(1.5);
    // As TCP ChangePriority, 2.9.10 and BullMQ: a missing priority is 0.
    await run({ jobId: String(job.id) });
    expect((await manager.getJob(job.id))?.priority).toBe(0);
  });

  test('a non-boolean lifo on PUSH keeps the queue ordering consistent', async () => {
    manager = new QueueManager();
    const queue = 'setters-lifo';
    await manager.push(queue, { data: { n: 1 }, lifo: true });
    await manager.push(queue, { data: { n: 2 }, lifo: 1 as unknown as boolean });
    await manager.push(queue, { data: { n: 3 }, lifo: true });
    const order: number[] = [];
    for (let i = 0; i < 3; i++) {
      const pulled = await manager.pull(queue);
      order.push((pulled?.data as { n: number } | undefined)?.n ?? -1);
    }
    expect(order).toEqual([3, 2, 1]);
  });
});
