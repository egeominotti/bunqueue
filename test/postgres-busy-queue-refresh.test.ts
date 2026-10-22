/**
 * Issue #161: on a busy queue a full-queue refresh must still apply. Every load of the
 * queue here is invalidated by a write to another job of the same queue that lands after
 * PostgreSQL returned the read model: a remote write whose event this broker receives
 * before the load returns, or an own committed write. The refresh must still install a
 * queue-level change made by another broker (a pause, a drain that journals no per-job
 * event) within that bounded number of loads, and a broker's own queue-wide durable
 * operation must be visible when it returns, also when the operation's own per-job
 * events arrive while its refresh loads. A load past the budget is held until the test
 * ends, so an implementation that only applies once the writes stop fails instead of
 * passing late. The guard cases check that a job changed while a refresh loads keeps its
 * newer state (also when only a projection that loaded meanwhile holds it), that a job
 * created meanwhile is not removed (also from a queue the read model says does not
 * exist), that a projection loaded before a refresh began does not keep a drained job,
 * that an older read model never replaces a newer one installed first, and that a later
 * refresh dropped as older is run again. The journal horizon those rules compare against
 * must never decrease.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { PostgresQueueManager } from '../src/application/postgresQueueManager';
import type { JobId } from '../src/domain/types/job';
import { prunePostgresEventCommits } from '../src/infrastructure/persistence/postgres/eventJournal';
import {
  cleanupPostgresNamespace,
  deferred,
  eventually,
  pausePostgresEventStream,
  postgresEventStream,
  postgresManagerStore,
} from './support/postgres-event-race';

const postgresUrl = Bun.env.BUNQUEUE_TEST_POSTGRES_URL;
const namespaces: string[] = [];
/** Invalidated loads allowed before a refresh must have applied. */
const INVALIDATED_LOADS = 5;

interface RefreshInternals {
  readonly queueRefreshes: { settled(): Promise<unknown> };
  scheduleQueueRefresh(queue: string): void;
}

function internals(broker: PostgresQueueManager): RefreshInternals {
  return broker as unknown as RefreshInternals;
}

function namespace(label: string): string {
  const value = `test-busy-refresh-${label}-${Date.now()}-${crypto.randomUUID()}`;
  namespaces.push(value);
  return value;
}

function manager(value: string, brokerId: string): PostgresQueueManager {
  return new PostgresQueueManager({
    postgres: { url: postgresUrl!, namespace: value, brokerId, pollIntervalMs: 25 },
  });
}

function has(broker: PostgresQueueManager, queue: string, id: JobId, state?: string): boolean {
  return broker.getJobs(queue, state ? { state } : {}).some((job) => job.id === id);
}

/** Wait until `broker` has received every event committed so far. */
async function caughtUp(broker: PostgresQueueManager): Promise<void> {
  const stream = postgresEventStream(broker);
  const store = postgresManagerStore(broker);
  expect(await eventually(async () => stream.cursor >= (await store.latestEventId()))).toBe(true);
}

/**
 * Run `afterLoad(n)` for the n-th read model of `queue`, after PostgreSQL returned it and
 * before the broker installs it. Returns the load counter and a restore function.
 */
function interceptLoads(
  broker: PostgresQueueManager,
  queue: string,
  afterLoad: (load: number) => Promise<void>
): { loads: () => number; restore: () => void } {
  const store = postgresManagerStore(broker);
  const original = store.loadQueueReadModel;
  let loads = 0;
  store.loadQueueReadModel = async (...args) => {
    const model = await original(...args);
    if (args[0] === queue) await afterLoad(++loads);
    return model;
  };
  return { loads: () => loads, restore: () => (store.loadQueueReadModel = original) };
}

/** Hold the first read model of `queue` after PostgreSQL returned it, until released. */
function holdFirstLoad(broker: PostgresQueueManager, queue: string) {
  const loaded = deferred<undefined>();
  const release = deferred<undefined>();
  const intercepted = interceptLoads(broker, queue, async (load) => {
    if (load !== 1) return;
    loaded.resolve(undefined);
    await release.promise;
  });
  return {
    loaded: loaded.promise,
    loads: intercepted.loads,
    release: () => release.resolve(undefined),
    restore: () => {
      release.resolve(undefined);
      intercepted.restore();
    },
  };
}

/** Invalidate the first INVALIDATED_LOADS loads with `write`; hold every later one. */
function invalidateEveryLoad(
  broker: PostgresQueueManager,
  queue: string,
  write: (load: number) => Promise<void>
): { loads: () => number; restore: () => void } {
  const held = deferred<undefined>();
  const intercepted = interceptLoads(broker, queue, async (load) => {
    if (load <= INVALIDATED_LOADS) await write(load);
    else await held.promise;
  });
  return {
    loads: intercepted.loads,
    restore: () => {
      intercepted.restore();
      held.resolve(undefined);
    },
  };
}

async function withBrokers(
  label: string,
  run: (local: PostgresQueueManager, remote: PostgresQueueManager, queue: string) => Promise<void>
): Promise<void> {
  const value = namespace(label);
  const local = manager(value, `${label}-local`);
  const remote = manager(value, `${label}-remote`);
  try {
    await Promise.all([local.waitUntilReady(), remote.waitUntilReady()]);
    await run(local, remote, `busy-${label}`);
    await (local as unknown as RefreshInternals).queueRefreshes.settled();
  } finally {
    await Promise.allSettled([local.shutdownPostgres(), remote.shutdownPostgres()]);
  }
}

/** A remote write to a new job of `queue` whose event `local` receives before returning. */
function remoteWrite(local: PostgresQueueManager, remote: PostgresQueueManager, queue: string) {
  return async (load: number) => {
    await remote.push(queue, { data: { concurrent: load } });
    await caughtUp(local);
  };
}

afterAll(async () => {
  if (!postgresUrl) return;
  for (const value of namespaces) await cleanupPostgresNamespace(postgresUrl, value);
});

describe('PostgreSQL full-queue refreshes on a busy queue (#161)', () => {
  test.skipIf(!postgresUrl)('a remote pause applies while every load is invalidated', async () => {
    await withBrokers('pause', async (local, remote, queue) => {
      await local.push(queue, { data: { role: 'existing' } });
      await caughtUp(local);
      const loads = invalidateEveryLoad(local, queue, remoteWrite(local, remote, queue));
      try {
        await remote.pauseDurable(queue, true);
        expect(
          await eventually(() => local.isPaused(queue) || loads.loads() > INVALIDATED_LOADS, 5_000)
        ).toBe(true);
        expect(local.isPaused(queue)).toBe(true);
      } finally {
        loads.restore();
      }
    });
  });

  test.skipIf(!postgresUrl)('a remote drain applies while every load is invalidated', async () => {
    await withBrokers('drain', async (local, remote, queue) => {
      const drained = await local.pushBatch(queue, [{ data: { n: 1 } }, { data: { n: 2 } }]);
      await caughtUp(local);
      const visible = () => drained.filter((id) => has(local, queue, id));
      expect(visible()).toHaveLength(2);
      const loads = invalidateEveryLoad(local, queue, remoteWrite(local, remote, queue));
      try {
        // A drain journals one queue event and no per-job event: only a full refresh
        // removes the drained jobs from this broker's snapshot.
        expect(await remote.drainDurable(queue)).toBe(2);
        expect(
          await eventually(() => visible().length === 0 || loads.loads() > INVALIDATED_LOADS, 5_000)
        ).toBe(true);
        expect(visible()).toEqual([]);
      } finally {
        loads.restore();
      }
    });
  });

  test.skipIf(!postgresUrl)(
    'an own drain is visible on return while own writes land during its refresh',
    async () => {
      await withBrokers('own-drain', async (local, _remote, queue) => {
        const drained = await local.pushBatch(queue, [{ data: { n: 1 } }, { data: { n: 2 } }]);
        await caughtUp(local);
        let concurrent: JobId[] = [];
        const loads = invalidateEveryLoad(local, queue, async (load) => {
          concurrent = [...concurrent, (await local.push(queue, { data: { load } })).id];
        });
        try {
          expect(await local.drainDurable(queue)).toBe(2);
          expect(drained.filter((id) => has(local, queue, id))).toEqual([]);
          // A job pushed after the drain's read model was taken is not removed by it.
          expect(concurrent.length).toBeGreaterThan(0);
          expect(concurrent.every((id) => has(local, queue, id, 'waiting'))).toBe(true);
        } finally {
          loads.restore();
        }
      });
    }
  );

  test.skipIf(!postgresUrl)(
    'an own clean is visible on return when its own events arrive while its refresh loads',
    async () => {
      await withBrokers('own-clean', async (local, _remote, queue) => {
        const ids = await local.pushBatch(queue, [{ data: { n: 1 } }, { data: { n: 2 } }]);
        for (const _ of ids) {
          const claimed = await local.pullWithLock(queue, 'clean-worker');
          await local.ack(claimed.job!.id, 'done', claimed.token!);
        }
        await caughtUp(local);
        // Only the full refresh can remove the cleaned jobs: per-job projections wait.
        const store = postgresManagerStore(local);
        const loadProjections = store.loadJobProjections;
        const projectionsHeld = deferred<undefined>();
        store.loadJobProjections = async (...args) => {
          await projectionsHeld.promise;
          return await loadProjections(...args);
        };
        // The clean's own per-job events reach the broker while its refresh loads; the
        // read model already holds that commit, so they must not keep the cleaned jobs.
        const intercepted = interceptLoads(local, queue, () => caughtUp(local));
        try {
          expect([...(await local.cleanDurable(queue, 0, 'completed'))].sort()).toEqual(
            [...ids].sort()
          );
          expect(ids.filter((id) => has(local, queue, id))).toEqual([]);
        } finally {
          projectionsHeld.resolve(undefined);
          store.loadJobProjections = loadProjections;
          intercepted.restore();
        }
      });
    }
  );

  test.skipIf(!postgresUrl)(
    'an own durable pause is visible on return while remote writes land during its refresh',
    async () => {
      await withBrokers('own-pause', async (local, remote, queue) => {
        await local.push(queue, { data: { role: 'existing' } });
        await caughtUp(local);
        const loads = invalidateEveryLoad(local, queue, remoteWrite(local, remote, queue));
        try {
          await local.pauseDurable(queue, true);
          expect(local.isPaused(queue)).toBe(true);
        } finally {
          loads.restore();
        }
      });
    }
  );
});

describe('PostgreSQL partial full-queue refresh guards (#161)', () => {
  test.skipIf(!postgresUrl)(
    'keeps the newer state of jobs changed while it loads and still applies',
    async () => {
      await withBrokers('partial', async (local, remote, queue) => {
        const existing = await local.push(queue, { data: { role: 'existing' } });
        await caughtUp(local);
        let fresh: JobId | null = null;
        const intercepted = interceptLoads(local, queue, async (load) => {
          if (load !== 1) return;
          // Both writes commit after this read model was taken; their projections reach
          // this broker's snapshot before the read model is installed.
          expect((await remote.pullWithLock(queue, 'partial-worker')).job?.id).toBe(existing.id);
          fresh = (await remote.push(queue, { data: { role: 'fresh' } })).id;
          expect(
            await eventually(
              () => has(local, queue, existing.id, 'active') && has(local, queue, fresh!, 'waiting')
            )
          ).toBe(true);
        });
        try {
          // A queue-level change starts the refresh; only a full refresh installs it.
          await remote.setConcurrencyDurable(queue, 7);
          expect(
            await eventually(() => local.getQueueLimits(queue).concurrencyLimit === 7, 5_000)
          ).toBe(true);
          await (local as unknown as RefreshInternals).queueRefreshes.settled();
          expect(has(local, queue, existing.id, 'active')).toBe(true);
          expect(has(local, queue, fresh!, 'waiting')).toBe(true);
          // The read model was installed once, around the two jobs, not discarded.
          expect(intercepted.loads()).toBe(1);
        } finally {
          intercepted.restore();
        }
      });
    }
  );

  test.skipIf(!postgresUrl)(
    'never installs an older read model over a newer one installed first',
    async () => {
      await withBrokers('ordering', async (local, remote, queue) => {
        const job = await local.push(queue, { data: { role: 'drained' } });
        await caughtUp(local);
        // Undelivered events start no refresh, so the first load is the drain's own.
        const stream = await pausePostgresEventStream(local);
        const loaded = deferred<undefined>();
        const release = deferred<undefined>();
        const intercepted = interceptLoads(local, queue, async (load) => {
          if (load !== 1) return;
          loaded.resolve(undefined);
          await release.promise;
        });
        try {
          // The drain's own refresh takes its read model, then waits.
          const drain = local.drainDurable(queue);
          await loaded.promise;
          // A newer remote change reaches this broker, and a later refresh installs it.
          await remote.setConcurrencyDurable(queue, 9);
          await stream.drain();
          expect(
            await eventually(() => local.getQueueLimits(queue).concurrencyLimit === 9, 5_000)
          ).toBe(true);
          release.resolve(undefined);
          expect(await drain).toBe(1);
          await (local as unknown as RefreshInternals).queueRefreshes.settled();
          expect(local.getQueueLimits(queue).concurrencyLimit).toBe(9);
          expect(has(local, queue, job.id)).toBe(false);
        } finally {
          release.resolve(undefined);
          intercepted.restore();
        }
      });
    }
  );

  test.skipIf(!postgresUrl)(
    'keeps a remote change that a projection installed while it loads',
    async () => {
      await withBrokers('projection', async (local, remote, queue) => {
        const stream = await pausePostgresEventStream(local);
        const job = await remote.push(queue, { data: { role: 'claimed' } });
        const store = postgresManagerStore(local);
        const loadProjections = store.loadJobProjections;
        const projectionsHeld = deferred<undefined>();
        store.loadJobProjections = async (...args) => {
          await projectionsHeld.promise;
          return await loadProjections(...args);
        };
        const held = holdFirstLoad(local, queue);
        try {
          internals(local).scheduleQueueRefresh(queue);
          await held.loaded; // this read model holds the job waiting
          await stream.drain(); // its push event, at or below the horizon, arrives now
          // Another broker claims the job after the snapshot; that event stays undelivered,
          // and the push's projection, which loads only now, reads the claim.
          expect((await remote.pullWithLock(queue, 'projection-worker')).job?.id).toBe(job.id);
          projectionsHeld.resolve(undefined);
          expect(await eventually(() => has(local, queue, job.id, 'active'))).toBe(true);
          held.release();
          await internals(local).queueRefreshes.settled();
          expect(has(local, queue, job.id, 'active')).toBe(true);
          expect(held.loads()).toBe(1);
        } finally {
          projectionsHeld.resolve(undefined);
          store.loadJobProjections = loadProjections;
          held.restore();
        }
      });
    }
  );

  test.skipIf(!postgresUrl)(
    'removes a drained job that an older projection installs while it loads',
    async () => {
      await withBrokers('older-projection', async (local, remote, queue) => {
        const job = await local.push(queue, { data: { role: 'drained' } });
        await caughtUp(local);
        await pausePostgresEventStream(local);
        const store = postgresManagerStore(local);
        const loadProjections = store.loadJobProjections;
        const projectionRead = deferred<undefined>();
        const projectionHeld = deferred<undefined>();
        store.loadJobProjections = async (...args) => {
          const projections = await loadProjections(...args);
          projectionRead.resolve(undefined);
          await projectionHeld.promise;
          return projections;
        };
        const held = holdFirstLoad(local, queue);
        try {
          // A read loads the job before the drain and installs it only after the refresh
          // below has begun. The drain journals no per-job event, so only that refresh
          // can remove the job: the older projection must not make it keep the job.
          const read = local.getJobState(job.id);
          await projectionRead.promise;
          expect(await remote.drainDurable(queue)).toBe(1);
          internals(local).scheduleQueueRefresh(queue);
          await held.loaded;
          projectionHeld.resolve(undefined);
          expect(await read).toBe('waiting');
          expect(has(local, queue, job.id)).toBe(true);
          held.release();
          await internals(local).queueRefreshes.settled();
          expect(has(local, queue, job.id)).toBe(false);
        } finally {
          projectionHeld.resolve(undefined);
          store.loadJobProjections = loadProjections;
          held.restore();
        }
      });
    }
  );

  test.skipIf(!postgresUrl)(
    'refreshes again when a later refresh with an older snapshot is dropped',
    async () => {
      await withBrokers('reordered', async (local, remote, queue) => {
        const job = await remote.push(queue, { data: { role: 'drained' } });
        expect(await eventually(() => has(local, queue, job.id))).toBe(true);
        const stream = await pausePostgresEventStream(local);
        const store = postgresManagerStore(local);
        const original = store.loadQueueReadModel;
        const firstBegun = deferred<undefined>();
        const firstGate = deferred<undefined>();
        const secondLoaded = deferred<undefined>();
        const secondGate = deferred<undefined>();
        let calls = 0;
        store.loadQueueReadModel = async (...args) => {
          if (args[0] !== queue) return await original(...args);
          const call = ++calls;
          if (call === 1) {
            firstBegun.resolve(undefined);
            await firstGate.promise; // its snapshot is taken late
          }
          const model = await original(...args);
          if (call === 2) {
            secondLoaded.resolve(undefined);
            await secondGate.promise;
          }
          return model;
        };
        try {
          // The first load (an own post-commit refresh) begins; a read made meanwhile
          // records the job for it. A remote drain, which journals no per-job event,
          // then deletes the job, and its invalidation starts a second load whose snapshot
          // lacks the job. The first load takes its snapshot only after a later commit,
          // installs with the higher horizon and keeps the job; the second is older.
          const operation = local.setConcurrencyDurable(queue, 5);
          await firstBegun.promise;
          expect(await local.getJobState(job.id)).toBe('waiting');
          expect(await remote.drainDurable(queue)).toBe(1);
          await stream.drain();
          await secondLoaded.promise;
          await remote.push(queue, { data: { role: 'later' } });
          firstGate.resolve(undefined);
          await operation;
          expect(has(local, queue, job.id)).toBe(true);
          secondGate.resolve(undefined);
          expect(await eventually(() => !has(local, queue, job.id))).toBe(true);
          expect(calls).toBe(3);
        } finally {
          firstGate.resolve(undefined);
          secondGate.resolve(undefined);
          store.loadQueueReadModel = original;
        }
      });
    }
  );

  test.skipIf(!postgresUrl)(
    'keeps an own push to a queue that its read model says does not exist',
    async () => {
      await withBrokers('absent', async (local, _remote, queue) => {
        await pausePostgresEventStream(local);
        const held = holdFirstLoad(local, queue);
        try {
          internals(local).scheduleQueueRefresh(queue);
          await held.loaded; // the queue has no job and no state in this read model
          const job = await local.push(queue, { data: { role: 'own' } });
          expect(has(local, queue, job.id, 'waiting')).toBe(true);
          held.release();
          await internals(local).queueRefreshes.settled();
          expect(has(local, queue, job.id, 'waiting')).toBe(true);
          expect(held.loads()).toBe(1);
        } finally {
          held.restore();
        }
      });
    }
  );
});

describe('PostgreSQL journal horizon (#161)', () => {
  test.skipIf(!postgresUrl)('never decreases when commit envelopes are collected', async () => {
    const value = namespace('horizon');
    const broker = new PostgresQueueManager({
      maxQueueEvents: 1,
      postgres: { url: postgresUrl!, namespace: value, brokerId: 'horizon', pollIntervalMs: 25 },
    });
    try {
      await broker.waitUntilReady();
      const store = postgresManagerStore(broker);
      const horizon = async () => (await store.loadQueueReadModel('horizon-a')).horizon;
      let previous = await horizon();
      // With one retained event per queue, each push orphans that queue's older commits.
      for (const queue of ['horizon-a', 'horizon-b', 'horizon-a', 'horizon-b']) {
        await broker.push(queue, { data: {} });
        const current = await horizon();
        expect(current).toBeGreaterThan(previous);
        previous = current;
      }
      // Obliteration deletes the history of the queue holding the newest commit.
      await broker.obliterateDurable('horizon-b');
      const beforeCollection = await horizon();
      expect(beforeCollection).toBeGreaterThan(previous);
      expect(await prunePostgresEventCommits(store.context)).toBeGreaterThan(0);
      expect(await horizon()).toBe(beforeCollection);
    } finally {
      await broker.shutdownPostgres();
    }
  });
});
