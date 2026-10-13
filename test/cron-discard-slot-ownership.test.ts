/**
 * Slot ownership on the exits that discard a `preventOverlap` cron job (unique key
 * `cron:<name>`) instead of requeueing it (#73, #75): a client disconnect
 * (`releaseJobToQueue`, src/application/clientTracking.ts), a stall retry and a stall
 * to the DLQ (`retryStalliedJob`, `moveStalliedJobToDlq`, src/application/stallDetection.ts)
 * and lock expiry. Under a queue concurrency limit and under a group concurrency
 * limit, each exit frees the cron job's own slot exactly once: the other active job
 * keeps its slot, the freed slot admits exactly one waiting job, and a repeated release
 * or a late ACK of the discarded job frees nothing (no phantom, never below the
 * number of active jobs). The non-cron exits are covered by
 * concurrency-limit-slot-ownership.test.ts and group-slot-ownership.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { checkExpiredLocks } from '../src/application/lockManager';
import { handleStalledJob } from '../src/application/stallDetection';
import type { BackgroundContext, LockContext } from '../src/application/types';
import type { Shard } from '../src/domain/queue/shard';
import type { Job, JobId } from '../src/domain/types/job';
import type { ConcurrencyLimiter } from '../src/domain/types/queue';
import type { GroupPullOptions } from '../src/domain/types/group';
import { StallAction } from '../src/domain/types/stall';
import { processingShardIndex, shardIndex } from '../src/shared/hash';

interface Contexts {
  getBackgroundContext(): BackgroundContext;
  getLockContext(): LockContext;
}

let qm: QueueManager | null = null;

afterEach(() => {
  qm?.shutdown();
  qm = null;
});

function contexts(manager: QueueManager): Contexts {
  return (manager as unknown as { contextFactory: Contexts }).contextFactory;
}

function processingJob(manager: QueueManager, id: JobId): Job | undefined {
  const ctx = contexts(manager).getBackgroundContext();
  return ctx.processingShards[processingShardIndex(id)].get(id);
}

/** Slots held in the queue's concurrency limiter (by job id). */
function queueSlots(manager: QueueManager, queue: string): number {
  const shard = (manager as unknown as { shards: Shard[] }).shards[shardIndex(queue)];
  const limiters = (
    shard as unknown as { limiterManager: { concurrencyLimiters: Map<string, ConcurrencyLimiter> } }
  ).limiterManager.concurrencyLimiters;
  return limiters.get(queue)?.getActive() ?? 0;
}

/** How the two limits are set up, pulled and read. */
interface Mode {
  readonly name: string;
  readonly groupId?: string;
  readonly pullOptions?: GroupPullOptions;
  limit(manager: QueueManager, queue: string): void;
  held(manager: QueueManager, queue: string): number | Promise<number>;
}

const modes: Mode[] = [
  {
    name: 'queue concurrency',
    limit: (m, queue) => m.setConcurrency(queue, 2),
    held: queueSlots,
  },
  {
    name: 'group concurrency',
    groupId: 'g',
    pullOptions: { concurrency: 2 },
    limit: () => undefined,
    held: (m, queue) => m.getGroupActiveCount(queue, 'g'),
  },
];

/** Pulls until the gate closes and returns how many jobs it admitted. */
async function admitted(manager: QueueManager, queue: string, mode: Mode): Promise<number> {
  let count = 0;
  while ((await manager.pull(queue, 0, undefined, mode.pullOptions)) !== null) count++;
  return count;
}

/** The cron job and one other job hold both slots; three more jobs wait. */
async function cronHoldingSlot(mode: Mode, queue: string, lockTtl: number, maxAttempts: number) {
  const manager = new QueueManager();
  qm = manager;
  mode.limit(manager, queue);
  const cronKey = `cron:${queue}`;
  await manager.push(queue, {
    data: { role: 'cron' },
    uniqueKey: cronKey,
    groupId: mode.groupId,
    maxAttempts,
    backoff: 60_000,
  });
  for (let i = 0; i < 3; i++) await manager.push(queue, { data: { i }, groupId: mode.groupId });
  const pulled = await manager.pullWithLock(
    queue,
    'cron-worker',
    0,
    lockTtl,
    undefined,
    mode.pullOptions
  );
  expect(pulled.job?.uniqueKey).toBe(cronKey);
  expect(await manager.pull(queue, 0, undefined, mode.pullOptions)).not.toBeNull();
  expect(await admitted(manager, queue, mode)).toBe(0);
  expect(await mode.held(manager, queue)).toBe(2);
  return { manager, cron: pulled.job!, token: pulled.token! };
}

interface CronExit {
  readonly lockTtl?: number;
  readonly maxAttempts?: number;
  /** Ends the cron job's delivery; called twice, the second call must free nothing. */
  release(manager: QueueManager, cron: Job): Promise<unknown>;
}

const stall = (action: StallAction) => (m: QueueManager, cron: Job) =>
  handleStalledJob(processingJob(m, cron.id) ?? cron, action, contexts(m).getBackgroundContext());

const exits: Array<[string, CronExit]> = [
  [
    'client disconnect',
    {
      release: (m, cron) => {
        m.registerClientJob('client-cron', cron.id);
        return m.releaseClientJobs('client-cron');
      },
    },
  ],
  ['stall retry', { release: stall(StallAction.Retry) }],
  ['stall to the DLQ', { release: stall(StallAction.MoveToDlq) }],
  ['stall at max attempts', { maxAttempts: 1, release: stall(StallAction.Retry) }],
  [
    'lock expiry',
    {
      lockTtl: 40,
      release: async (m) => {
        await Bun.sleep(80);
        await checkExpiredLocks(contexts(m).getLockContext());
      },
    },
  ],
];

for (const mode of modes) {
  describe(`a discarded cron job frees its own ${mode.name} slot exactly once`, () => {
    for (const [name, exit] of exits) {
      test(name, async () => {
        const queue = `cron-slot-${mode.groupId ?? 'q'}-${name.replaceAll(' ', '-')}`;
        const { manager, cron, token } = await cronHoldingSlot(
          mode,
          queue,
          exit.lockTtl ?? 60_000,
          exit.maxAttempts ?? 5
        );

        await exit.release(manager, cron);
        // Discarded, not requeued or dead-lettered: the scheduler re-creates it.
        expect(await manager.getJobState(cron.id)).toBe('unknown');
        expect(await mode.held(manager, queue)).toBe(1);
        expect(await admitted(manager, queue, mode)).toBe(1);
        expect(await mode.held(manager, queue)).toBe(2);

        // A repeated release and a late ACK of the discarded job free nothing.
        await exit.release(manager, cron);
        await manager.ack(cron.id, 'late', token).catch(() => undefined);
        expect(await mode.held(manager, queue)).toBe(2);
        expect(await admitted(manager, queue, mode)).toBe(0);
        expect(manager.getQueueJobCounts(queue).active).toBe(2);
        expect(await mode.held(manager, queue)).toBe(manager.getQueueJobCounts(queue).active);
      });
    }
  });
}
