/**
 * Issue #158: a full-queue refresh whose REPEATABLE READ snapshot was taken before the
 * broker's own committed change must not roll that change back in the broker's own
 * snapshot. Each test holds such a refresh after PostgreSQL returned it, makes the
 * change on the same broker while its event stream is paused (so no received event can
 * mark the refresh stale), then releases the refresh and checks that the broker still
 * reports its own write, also when a background retry rather than the direct reload
 * installs it, and for a job this broker has not seen yet. A direct read or a rejected
 * write commits nothing and must not discard the refresh, an own write with no refresh
 * in flight must not load the queue at all, and an own reload must not discard the
 * refresh the same operation started after its commit. Lease renewals are deliberately
 * not covered (see `invalidateQueueRefreshes`).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { PostgresQueueManager } from '../src/application/postgresQueueManager';
import type { JobId } from '../src/domain/types/job';
import type { PostgresQueueStore } from '../src/infrastructure/persistence/postgres';
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

interface RefreshInternals {
  scheduleQueueRefresh(queue: string): void;
  readonly queueRefreshes: { settled(): Promise<unknown> };
  readonly projectionRefreshes: {
    drain(): Promise<void>;
    beginDirect(id: JobId, queue: string): unknown;
  };
}

/** The projection installer's callback: `(id, projection, ownWrite, ...)`. */
type ProjectionApply = (
  id: JobId,
  projection: unknown,
  ownWrite: boolean,
  ...rest: unknown[]
) => void;

function internals(broker: PostgresQueueManager): RefreshInternals {
  return broker as unknown as RefreshInternals;
}

/** Observe every per-job install; returns a function that restores the original. */
function observeInstalls(broker: PostgresQueueManager, observe: ProjectionApply): () => void {
  const refreshes = internals(broker).projectionRefreshes;
  const original = Reflect.get(refreshes, 'apply') as ProjectionApply;
  Reflect.set(refreshes, 'apply', (...args: Parameters<ProjectionApply>) => {
    original(...args);
    observe(...args);
  });
  return () => Reflect.set(refreshes, 'apply', original);
}

function namespace(label: string): string {
  const value = `test-own-write-refresh-${label}-${Date.now()}-${crypto.randomUUID()}`;
  namespaces.push(value);
  return value;
}

function manager(value: string, brokerId: string): PostgresQueueManager {
  return new PostgresQueueManager({
    postgres: { url: postgresUrl!, namespace: value, brokerId, pollIntervalMs: 25 },
  });
}

function projectionIdle(broker: PostgresQueueManager): boolean {
  const refreshes = internals(broker).projectionRefreshes;
  const pending = Reflect.get(refreshes, 'pending') as Map<JobId, unknown>;
  const active = Reflect.get(refreshes, 'active') as Set<unknown>;
  return pending.size === 0 && active.size === 0;
}

function has(broker: PostgresQueueManager, queue: string, id: JobId, state: string): boolean {
  return broker.getJobs(queue, { state }).some((job) => job.id === id);
}

function dlqIds(broker: PostgresQueueManager, queue: string): JobId[] {
  return broker.getDlq(queue).map((job) => job.id);
}

/**
 * Deliver every committed event, stop further delivery, and wait until no projection or
 * queue refresh is running, so the next queue refresh is the only one in flight.
 */
async function pauseCaughtUp(broker: PostgresQueueManager) {
  const stream = postgresEventStream(broker);
  const store = postgresManagerStore(broker);
  expect(await eventually(async () => stream.cursor >= (await store.latestEventId()))).toBe(true);
  await pausePostgresEventStream(broker);
  expect(await eventually(() => projectionIdle(broker))).toBe(true);
  await internals(broker).queueRefreshes.settled();
  return stream;
}

/**
 * Start a full refresh of `queue`, hold its read model after PostgreSQL returned it, run
 * `write` on the same broker, then let the older read model reach the snapshot. `visible`
 * must hold right after the write, after that refresh settles, and after the paused
 * events are finally delivered. `beforeRefresh` runs once events are paused, before the
 * refresh loads. Returns how many read models of `queue` were loaded until it settled.
 */
async function expectVisibleAfterOlderRefresh(
  broker: PostgresQueueManager,
  queue: string,
  write: () => Promise<void>,
  visible: () => boolean,
  beforeRefresh: () => Promise<void> = async () => undefined
): Promise<number> {
  const stream = await pauseCaughtUp(broker);
  await beforeRefresh();
  const cursor = stream.cursor;
  const store = postgresManagerStore(broker);
  const original = store.loadQueueReadModel;
  const loaded = deferred<undefined>();
  const release = deferred<undefined>();
  let loads = 0;
  store.loadQueueReadModel = async (...args) => {
    const model = await original(...args);
    if (args[0] === queue && ++loads === 1) {
      loaded.resolve(undefined);
      await release.promise;
    }
    return model;
  };
  try {
    internals(broker).scheduleQueueRefresh(queue);
    await loaded.promise;
    await write();
    expect(visible()).toBe(true);
    release.resolve(undefined);
    await internals(broker).queueRefreshes.settled();
    // The own event is still undelivered: only the write itself can fence the refresh.
    expect(stream.cursor).toBe(cursor);
    expect(visible()).toBe(true);
  } finally {
    release.resolve(undefined);
    store.loadQueueReadModel = original;
  }
  const settledLoads = loads;
  await stream.drain();
  expect(await eventually(visible)).toBe(true);
  return settledLoads;
}

async function withBroker(
  label: string,
  run: (broker: PostgresQueueManager, queue: string, value: string) => Promise<void>
): Promise<void> {
  const value = namespace(label);
  const broker = manager(value, `${label}-broker`);
  try {
    await broker.waitUntilReady();
    await run(broker, `own-${label}`, value);
  } finally {
    await broker.shutdownPostgres();
  }
}

afterAll(async () => {
  if (!postgresUrl) return;
  for (const value of namespaces) await cleanupPostgresNamespace(postgresUrl, value);
});

describe('PostgreSQL own writes versus an older in-flight queue refresh (#158)', () => {
  test.skipIf(!postgresUrl)('a terminal failure stays in the broker own DLQ', async () => {
    await withBroker('fail', async (broker, queue) => {
      const job = await broker.push(queue, { data: { role: 'fail' }, maxAttempts: 1 });
      const claimed = await broker.pullWithLock(queue, 'fail-worker');
      expect(claimed.job?.id).toBe(job.id);
      const loads = await expectVisibleAfterOlderRefresh(
        broker,
        queue,
        async () => {
          await broker.fail(job.id, 'boom', claimed.token ?? undefined);
        },
        () =>
          dlqIds(broker, queue).join() === String(job.id) && !has(broker, queue, job.id, 'active')
      );
      // The held read model is installed around the failed job, which keeps its committed
      // state, instead of being discarded and reloaded (#161); the write starts no reload.
      expect(loads).toBe(1);
    });
  });

  test.skipIf(!postgresUrl)('a batched completion stays completed', async () => {
    await withBroker('ackb', async (broker, queue) => {
      const job = await broker.push(queue, { data: { role: 'ackb' } });
      const claimed = await broker.pullWithLock(queue, 'ackb-worker');
      await expectVisibleAfterOlderRefresh(
        broker,
        queue,
        async () => {
          await broker.ackBatch([job.id], [claimed.token!]);
        },
        () => has(broker, queue, job.id, 'completed') && !has(broker, queue, job.id, 'active')
      );
    });
  });

  test.skipIf(!postgresUrl)('a claim stays active with its lock', async () => {
    await withBroker('claim', async (broker, queue) => {
      const job = await broker.push(queue, { data: { role: 'claim' } });
      let token = '';
      await expectVisibleAfterOlderRefresh(
        broker,
        queue,
        async () => {
          const claimed = await broker.pullWithLock(queue, 'claim-worker');
          expect(claimed.job?.id).toBe(job.id);
          token = claimed.token!;
        },
        () => has(broker, queue, job.id, 'active') && broker.verifyLock(job.id, token)
      );
    });
  });

  test.skipIf(!postgresUrl)('a pushed job stays visible', async () => {
    await withBroker('push', async (broker, queue) => {
      await broker.push(queue, { data: { role: 'existing' } });
      let pushed: JobId | null = null;
      await expectVisibleAfterOlderRefresh(
        broker,
        queue,
        async () => {
          pushed = (await broker.push(queue, { data: { role: 'pushed' } })).id;
        },
        () => pushed !== null && has(broker, queue, pushed, 'waiting')
      );
    });
  });

  test.skipIf(!postgresUrl)('a cancelled job stays removed', async () => {
    await withBroker('cancel', async (broker, queue) => {
      const job = await broker.push(queue, { data: { role: 'cancel' } });
      await expectVisibleAfterOlderRefresh(
        broker,
        queue,
        async () => {
          expect(await broker.cancel(job.id)).toBe(true);
        },
        () => !broker.getJobs(queue).some((candidate) => candidate.id === job.id)
      );
    });
  });

  test.skipIf(!postgresUrl)('a removed DLQ job stays removed', async () => {
    await withBroker('dlq-remove', async (broker, queue) => {
      const job = await broker.push(queue, { data: { role: 'dlq-remove' }, maxAttempts: 1 });
      const claimed = await broker.pullWithLock(queue, 'dlq-remove-worker');
      await broker.fail(job.id, 'boom', claimed.token ?? undefined);
      expect(dlqIds(broker, queue)).toEqual([job.id]);
      await expectVisibleAfterOlderRefresh(
        broker,
        queue,
        async () => {
          expect(await broker.removeDlqJobDurable(queue, job.id)).toBe(true);
        },
        () => dlqIds(broker, queue).length === 0
      );
    });
  });

  test.skipIf(!postgresUrl)(
    'a post-commit queue refresh is not replaced by an older one',
    async () => {
      await withBroker('drain', async (broker, queue) => {
        const job = await broker.push(queue, { data: { role: 'drain' } });
        await expectVisibleAfterOlderRefresh(
          broker,
          queue,
          async () => {
            expect(await broker.drainDurable(queue)).toBe(1);
          },
          () => !has(broker, queue, job.id, 'waiting')
        );
      });
    }
  );

  test.skipIf(!postgresUrl)('a direct job read does not discard the refresh', async () => {
    await withBroker('read', async (broker, queue) => {
      const job = await broker.push(queue, { data: { role: 'read' } });
      const loads = await expectVisibleAfterOlderRefresh(
        broker,
        queue,
        async () => {
          expect(await broker.getJobState(job.id)).toBe('waiting');
        },
        () => has(broker, queue, job.id, 'waiting')
      );
      // A read writes nothing, so the held read model is current and installed as is.
      expect(loads).toBe(1);
    });
  });

  test.skipIf(!postgresUrl)('an own write with no refresh in flight loads no queue', async () => {
    await withBroker('quiet', async (broker, queue) => {
      const job = await broker.push(queue, { data: { role: 'quiet' }, maxAttempts: 1 });
      const claimed = await broker.pullWithLock(queue, 'quiet-worker');
      await pauseCaughtUp(broker);
      const store = postgresManagerStore(broker);
      const original = store.loadQueueReadModel;
      let loads = 0;
      store.loadQueueReadModel = async (...args) => {
        loads++;
        return await original(...args);
      };
      try {
        await broker.fail(job.id, 'boom', claimed.token ?? undefined);
        await internals(broker).queueRefreshes.settled();
        expect(dlqIds(broker, queue)).toEqual([job.id]);
        expect(loads).toBe(0);
      } finally {
        store.loadQueueReadModel = original;
      }
    });
  });

  test.skipIf(!postgresUrl)('a rejected failure does not discard the refresh', async () => {
    await withBroker('rejected', async (broker, queue) => {
      const job = await broker.push(queue, { data: { role: 'rejected' }, maxAttempts: 1 });
      await broker.pullWithLock(queue, 'rejected-worker');
      const loads = await expectVisibleAfterOlderRefresh(
        broker,
        queue,
        async () => {
          await expect(broker.fail(job.id, 'boom', 'not-the-lease-token')).rejects.toThrow(
            'Invalid or expired lock token'
          );
        },
        () => has(broker, queue, job.id, 'active')
      );
      // Nothing was committed, so the held read model is current and installed as is.
      expect(loads).toBe(1);
    });
  });
});

describe('PostgreSQL own writes installed without their direct reload (#158)', () => {
  /** Fail a claimed job while `projections` intercepts the broker's per-job reloads. */
  async function expectFailureSurvives(
    label: string,
    projections: (
      broker: PostgresQueueManager,
      id: JobId,
      load: PostgresQueueStore['loadJobProjections']
    ) => PostgresQueueStore['loadJobProjections']
  ): Promise<void> {
    await withBroker(label, async (broker, queue) => {
      const job = await broker.push(queue, { data: { role: label }, maxAttempts: 1 });
      const claimed = await broker.pullWithLock(queue, `${label}-worker`);
      const store = postgresManagerStore(broker);
      const original = store.loadJobProjections;
      const inDlq = () =>
        dlqIds(broker, queue).join() === String(job.id) && !has(broker, queue, job.id, 'active');
      let directInstalls = 0;
      let restoreInstalls = () => undefined as unknown;
      try {
        await expectVisibleAfterOlderRefresh(
          broker,
          queue,
          async () => {
            await broker.fail(job.id, 'boom', claimed.token ?? undefined);
            // The background batch or a read, not the direct reload, installs the row.
            expect(await eventually(inDlq)).toBe(true);
            expect(directInstalls).toBe(0);
          },
          inDlq,
          async () => {
            store.loadJobProjections = projections(broker, job.id, original);
            restoreInstalls = observeInstalls(broker, (id, _projection, ownWrite) => {
              if (id === job.id && ownWrite) directInstalls++;
            });
          }
        );
      } finally {
        store.loadJobProjections = original;
        restoreInstalls();
      }
    });
  }

  test.skipIf(!postgresUrl)('after the direct reload fails once', async () => {
    await expectFailureSurvives('reload-error', (_broker, _id, load) => {
      let calls = 0;
      return async (...args) => {
        if (++calls === 1) throw new Error('injected projection failure');
        return await load(...args);
      };
    });
  });

  test.skipIf(!postgresUrl)('after direct reads supersede both reload attempts', async () => {
    await expectFailureSurvives('reload-superseded', (broker, id, load) => {
      let calls = 0;
      return async (...args) => {
        // A read of the same job starts while each own-write attempt loads; both
        // attempts are fenced out and the write falls back to a background batch.
        calls++;
        if (calls === 1 || calls === 3) void broker.getJobState(id).catch(() => undefined);
        return await load(...args);
      };
    });
  });

  test.skipIf(!postgresUrl)('after cancelling a job pushed through another broker', async () => {
    await withBroker('cancel-remote', async (broker, queue, value) => {
      await broker.push(queue, { data: { role: 'existing' } });
      const remote = manager(value, 'cancel-remote-producer');
      let pushed: JobId | null = null;
      const absent = () =>
        pushed !== null && !broker.getJobs(queue).some((job) => job.id === pushed);
      try {
        await remote.waitUntilReady();
        await expectVisibleAfterOlderRefresh(
          broker,
          queue,
          async () => {
            expect(await broker.cancel(pushed!)).toBe(true);
          },
          absent,
          async () => {
            // This broker has stopped receiving events, so it never sees the job locally.
            pushed = (await remote.push(queue, { data: { role: 'remote' } })).id;
            expect(broker.getJobs(queue).some((job) => job.id === pushed)).toBe(false);
          }
        );
      } finally {
        await remote.shutdownPostgres();
      }
    });
  });
});

describe('PostgreSQL own post-commit refreshes versus their own reloads (#158)', () => {
  test.skipIf(!postgresUrl)(
    'a batched repeat completion shows its next run on return',
    async () => {
      await withBroker('ackb-repeat', async (broker, queue) => {
        const job = await broker.push(queue, {
          data: { role: 'repeat' },
          repeat: { every: 60_000, limit: 5 },
        });
        const claimed = await broker.pullWithLock(queue, 'ackb-repeat-worker');
        expect(claimed.job?.id).toBe(job.id);
        await pauseCaughtUp(broker);
        const store = postgresManagerStore(broker);
        const completeMany = store.completeMany;
        const loadQueue = store.loadQueueReadModel;
        const installed = deferred<undefined>();
        const later = deferred<undefined>();
        let loads = 0;
        // Fence out the batch's direct ticket, so the job takes the repair reload path
        // while the batch also refreshes the queue for the repeat job's next run.
        store.completeMany = async (...args) => {
          const transitions = await completeMany.apply(store, args);
          internals(broker).projectionRefreshes.beginDirect(job.id, queue);
          return transitions;
        };
        const restoreInstalls = observeInstalls(broker, (id) => {
          if (id === job.id) installed.resolve(undefined);
        });
        // The post-commit queue load lands only after the repair reload installed the job;
        // a reload after a discarded refresh waits until the assertions are done.
        store.loadQueueReadModel = async (...args) => {
          const model = await loadQueue(...args);
          if (args[0] !== queue) return model;
          if (++loads === 1) await Promise.race([installed.promise, Bun.sleep(2_000)]);
          else await later.promise;
          return model;
        };
        try {
          await broker.ackBatch([job.id], [claimed.token!]);
          expect(broker.getJobs(queue).filter((candidate) => candidate.id !== job.id)).toHaveLength(
            1
          );
          expect(loads).toBe(1);
        } finally {
          later.resolve(undefined);
          store.completeMany = completeMany;
          store.loadQueueReadModel = loadQueue;
          restoreInstalls();
        }
      });
    }
  );
});
