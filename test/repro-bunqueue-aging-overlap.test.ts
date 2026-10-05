/**
 * Repro: priority aging started a tick on every interval even while the previous one
 * was still waiting on its job query or a priority update. With queries slower than the
 * interval (a short interval over a slow link), ticks piled up: each re-read the same
 * jobs and boosted them again, so a job gained several boosts per interval. At most one
 * tick may be in flight; a firing that finds one running is dropped, and dropped
 * firings must not burst once it settles. Driven on the fake runtime of
 * test/shared-timers-support.ts, with test-controlled gates for the job query and the
 * priority update.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { PriorityAger } from '../src/client/bunqueue/aging';
import type { Queue } from '../src/client/queue/queue';
import { installFakeTimers, restoreTimers } from './shared-timers-support';

const INTERVAL = 1_000;
let fake: ReturnType<typeof installFakeTimers>;

beforeEach(() => {
  fake = installFakeTimers();
});

afterEach(() => {
  restoreTimers();
});

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

interface Gate {
  readonly promise: Promise<void>;
  open(): void;
}

function gate(): Gate {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: () => resolve() };
}

/** A queue whose job query and priority updates each wait on their own gate. */
function gatedQueue(waitingJobs: unknown[]) {
  const queries: Gate[] = [];
  const updates: Gate[] = [];
  const queue = {
    getWaitingAsync: () => {
      const query = gate();
      queries.push(query);
      return query.promise.then(() => waitingJobs);
    },
    getJobsAsync: async () => [],
    changeJobPriority: () => {
      const update = gate();
      updates.push(update);
      return update.promise;
    },
  } as unknown as Queue<unknown>;
  /** Let every query started so far return its jobs. */
  const answerQueries = async (): Promise<void> => {
    for (const query of queries) query.open();
    await settle();
  };
  return { queue, queries, updates, answerQueries };
}

const oldJob = () => ({ id: 'old', timestamp: 0, priority: 1 });

test('a tick slower than the interval keeps the next ticks from starting, without a burst after', async () => {
  const { queue, queries, answerQueries } = gatedQueue([]);
  const ager = new PriorityAger({ interval: INTERVAL }, queue);
  ager.start();
  try {
    fake.advance(INTERVAL);
    expect(queries).toHaveLength(1);

    fake.advance(3 * INTERVAL); // three firings while the first tick waits on its query
    expect(queries).toHaveLength(1);

    await answerQueries(); // the first tick settles between two firings
    fake.advance(INTERVAL - 1);
    expect(queries).toHaveLength(1); // dropped firings are not replayed
    fake.advance(1);
    expect(queries).toHaveLength(2); // the next firing on the interval starts a tick
  } finally {
    ager.destroy();
  }
});

test('a job is boosted once while its priority update is slower than the interval', async () => {
  const { queue, queries, updates, answerQueries } = gatedQueue([oldJob()]);
  const ager = new PriorityAger({ interval: INTERVAL, minAge: 0 }, queue);
  ager.start();
  try {
    fake.advance(INTERVAL);
    await answerQueries();
    expect(updates).toHaveLength(1); // the first tick waits on the update

    for (let firing = 0; firing < 3; firing++) {
      fake.advance(INTERVAL);
      await answerQueries(); // a tick that started anyway would re-read the job
    }
    expect(updates).toHaveLength(1); // one boost for the job, not one per firing
    expect(queries).toHaveLength(1);

    updates[0].open();
    await settle();
    fake.advance(INTERVAL);
    await answerQueries();
    expect(queries).toHaveLength(2);
    expect(updates).toHaveLength(2);
  } finally {
    ager.destroy();
  }
});

test('after destroy() and start(), a stale tick still in flight makes no change and blocks overlap', async () => {
  const { queue, queries, updates, answerQueries } = gatedQueue([oldJob()]);
  const ager = new PriorityAger({ interval: INTERVAL, minAge: 0 }, queue);
  ager.start();
  try {
    fake.advance(INTERVAL);
    expect(queries).toHaveLength(1);

    ager.destroy();
    ager.start();
    fake.advance(INTERVAL); // the stale tick has not settled: no second tick yet
    expect(queries).toHaveLength(1);

    await answerQueries(); // the stale tick returns without boosting anything
    expect(updates).toHaveLength(0);

    fake.advance(INTERVAL);
    expect(queries).toHaveLength(2);
  } finally {
    ager.destroy();
  }
});
