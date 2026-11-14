import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { QueueManager } from '../src/application/queueManager';
import type { JobId } from '../src/domain/types/job';
import { raceConditionsFixture } from './support/race-conditions-fixture';
import { crossRetryDeadlineAfterWaitingRead } from './support/race-conditions-clock';
import {
  assertRaceConservation,
  chaosActions,
  runChaos,
  raceTraceJson,
  type ChaosAction,
} from './support/race-conditions-chaos';

describe('Race Condition Tests', () => {
  describe('4. Mixed Concurrent Operations Stress Test', () => {
    let qm: QueueManager;
    const fixture = raceConditionsFixture();
    beforeEach(async () => {
      qm = await fixture.create();
    });
    afterEach(() => fixture.close());

    async function populate(backoff?: number) {
      const ids: JobId[] = [];
      for (let i = 0; i < 100; i++) {
        const job = await qm.push('invariant-queue', {
          data: { i },
          maxAttempts: 10,
          ...(backoff === undefined ? {} : { backoff }),
        });
        ids.push(job.id);
      }
      expect(qm.getStats().waiting).toBe(100);
      return ids;
    }

    test('should maintain job count invariant under chaos', async () => {
      const seed = 0xc1a05;
      // Preserve default retry backoff. The seed fixes operation choices only;
      // runtime jitter and asynchronous completion order are captured in the trace.
      const actions = chaosActions(seed);
      const ids = await populate();
      const trace = await runChaos(qm, 'invariant-queue', actions);
      try {
        expect(trace).toHaveLength(200);
        for (const action of ['pull', 'ack', 'fail']) {
          expect(trace.some((entry) => entry.action === action && entry.id !== null)).toBe(true);
        }
        const snapshot = assertRaceConservation(qm, 'invariant-queue', ids);
        if (process.env.BUNQUEUE_RACE_TRACE === '1') {
          console.log(raceTraceJson({ seed, actions, trace, snapshot }));
        }
      } catch (cause) {
        throw new Error(JSON.stringify({ seed, actions, trace }), { cause });
      }
    });

    test('should account for all 100 jobs when 51 retries are delayed and 49 completed', async () => {
      // A controlled long backoff keeps the exact partition independent of runner speed.
      // The seeded case above exercises the original default-backoff contract.
      const ids = await populate(60_000);
      const actions: ChaosAction[] = [
        ...Array<ChaosAction>(51).fill('fail'),
        ...Array<ChaosAction>(49).fill('ack'),
        ...Array<ChaosAction>(100).fill('pull'),
      ];
      const trace = await runChaos(qm, 'invariant-queue', actions);
      expect(trace).toHaveLength(200);
      expect(trace.filter((entry) => entry.action === 'fail' && entry.id !== null)).toHaveLength(
        51
      );
      expect(trace.filter((entry) => entry.action === 'ack' && entry.id !== null)).toHaveLength(49);
      const { stats } = assertRaceConservation(qm, 'invariant-queue', ids);
      expect(stats.delayed).toBe(51);
      expect(stats.completed).toBe(49);
      expect(stats.waiting).toBe(0);
      expect(stats.active).toBe(0);
      expect(stats.dlq).toBe(0);
    });

    test('should reject a missing original job even when the legacy half-count passes', async () => {
      const ids = await populate(60_000);
      // Deliberately remove a retained job through the real persistence path to
      // prove the oracle cannot hide loss behind an aggregate half-count.
      expect(await qm.cancel(ids[0])).toBe(true);
      await runChaos(qm, 'invariant-queue', Array<ChaosAction>(200).fill('ack'));
      expect(qm.getStats().completed).toBe(99);
      expect(() => assertRaceConservation(qm, 'invariant-queue', ids)).toThrow(
        'Job conservation failed'
      );
    });

    test('should retain a retry when its deadline crosses between waiting and delayed reads', async () => {
      const job = await qm.push('invariant-queue', {
        data: { retry: true },
        maxAttempts: 2,
        backoff: 60_000,
      });
      expect((await qm.pull('invariant-queue', 0))?.id).toBe(job.id);
      expect(await qm.fail(job.id, 'retry across snapshot')).toBeUndefined();
      const retry = await qm.getJob(job.id);
      expect(retry).not.toBeNull();
      if (!retry) throw new Error('Missing retained retry');
      const { value, crossed } = crossRetryDeadlineAfterWaitingRead(qm, retry.runAt, () =>
        assertRaceConservation(qm, 'invariant-queue', [job.id])
      );
      expect(crossed).toBe(true);
      expect(value.stats.waiting).toBe(1);
      expect(value.stats.delayed).toBe(0);
      expect(value.membership.find(({ state }) => state === 'waiting')?.ids).toEqual([job.id]);
    });
  });
});
