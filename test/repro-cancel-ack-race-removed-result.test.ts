/**
 * Repro (pre-commit review of the removed-result record, issue #155): a Cancel that
 * races the job's own ACK left the result behind.
 *
 * `QueueManager.cancel` drops the job's removed-result record before it looks for the
 * job. When the job is active, Cancel refuses; if the job's ACK (`removeOnComplete`)
 * lands before the state read, the outcome is "missing" (`state: 'unknown'`), so
 * `remove()` resolves and TCP answers the legacy not-found reply — while the ACK has
 * just recorded the result again, and the completion lookup kept serving it for up to
 * 60 s. `remove()` must leave no result behind when it reports the job gone.
 */
import { afterEach, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { cancelWithOutcome } from '../src/domain/job/cancellation';
import type { JobId } from '../src/domain/types/job';

let manager: QueueManager | null = null;

afterEach(() => {
  manager?.shutdown();
  manager = null;
});

/** The real manager as the Cancel port, with the job's ACK landing just before the state read. */
function ackBeforeStateRead(m: QueueManager, jobId: JobId, result: unknown): QueueManager {
  let acked = false;
  return new Proxy(m, {
    get(target, property) {
      if (property === 'getJobState') {
        return async (id: JobId) => {
          if (!acked) {
            acked = true;
            await target.ack(jobId, result);
          }
          return target.getJobState(id);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as Function).bind(target) : value;
    },
  });
}

test('a Cancel that reports the job gone leaves no removed result behind', async () => {
  manager = new QueueManager();
  const m = manager;
  const queue = 'cancel-ack-race';
  await m.push(queue, { data: { secret: 'tok' }, removeOnComplete: true });
  const pulled = await m.pull(queue);
  expect(pulled).not.toBeNull();

  const outcome = await cancelWithOutcome(
    ackBeforeStateRead(m, pulled!.id, { answer: 42 }),
    pulled!.id
  );

  expect(outcome).toEqual({ removed: false, state: 'unknown' });
  expect(await m.getCompletionAsync(pulled!.id)).toEqual({ found: false, result: undefined });
});
