/**
 * A producer-supplied `limiter.groupKey` value whose string conversion throws
 * (for example `{ toString: 'x' }`, valid JSON and msgpack) must never turn a
 * successful job into a FAIL. Before the fix, the dynamic ACK ceiling read the
 * group value of every buffered delivery; the throw escaped `AckBatcher.queue()`
 * after the ACK was already buffered, so the worker sent FAIL for a job that
 * succeeded, stranded the ACK without a timer, and made the `concurrency`
 * setter throw while the poison job stayed buffered.
 */

import { describe, expect, test } from 'bun:test';
import { pack, unpack } from 'msgpackr';
import type { Job as InternalJob } from '../src/domain/types/job';
import { Worker } from '../src/client/worker';
import { AckBatcher } from '../src/client/worker/ackBatcher';
import { countImmediatelyStartableAckDeliveries } from '../src/client/worker/ackFrontier';
import { WORKER_CONSTANTS } from '../src/client/worker/constants';
import { GroupConcurrencyLimiter } from '../src/client/worker/groupConcurrency';
import type { TcpConnection } from '../src/client/worker/types';
import { closeAllSharedPools } from '../src/client/tcpPool';
import { FrameParser } from '../src/infrastructure/server/protocol';

function jobWith(data: unknown): InternalJob {
  return { id: 'unit', data } as unknown as InternalJob;
}

/** Fake broker: serves `jobs` through PULL/PULLB and records every disposition. */
function startFakeBroker(jobs: Array<{ id: string; data: Record<string, unknown> }>) {
  const acked: string[] = [];
  const failed: string[] = [];
  let next = 0;
  const take = (count: number) => {
    const out = jobs.slice(next, next + count);
    next += out.length;
    return out;
  };
  const server = Bun.listen<{ parser: FrameParser }>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        socket.data = { parser: new FrameParser() };
      },
      data(socket, chunk) {
        for (const frame of socket.data.parser.addData(new Uint8Array(chunk))) {
          const command = unpack(frame) as Record<string, unknown>;
          const response: Record<string, unknown> = { reqId: command.reqId, ok: true };
          if (command.cmd === 'PULLB') {
            const out = take(Number(command.count ?? 1));
            response.jobs = out;
            response.tokens = out.map((job) => `token-${job.id}`);
          } else if (command.cmd === 'PULL') {
            const [job] = take(1);
            response.job = job ?? null;
            response.token = job ? `token-${job.id}` : null;
          } else if (command.cmd === 'ACKB') {
            acked.push(...(command.ids as string[]));
          } else if (command.cmd === 'ACK') {
            acked.push(String(command.id));
          } else if (command.cmd === 'FAIL') {
            failed.push(String(command.id));
          }
          socket.write(FrameParser.frame(pack(response)));
        }
      },
    },
  });
  return { server, acked, failed };
}

function createWorker(port: number, concurrency: number, processor: (id: string) => unknown) {
  const worker = new Worker(
    `poison-group-${Bun.randomUUIDv7()}`,
    async (job) => processor(String(job.id)),
    {
      embedded: false,
      autorun: false,
      concurrency,
      batchSize: 10,
      skipStalledCheck: true,
      limiter: { groupKey: 'g', max: 1, duration: 1_000 },
      connection: { host: '127.0.0.1', port, poolSize: 1, pingInterval: 0, commandTimeout: 2_000 },
    }
  );
  const events: string[] = [];
  worker.on('error', (error) => events.push(`error ${error.message}`));
  worker.on('completed', (job) => events.push(`completed ${job.id}`));
  worker.on('failed', (job, error) => events.push(`failed ${job.id} ${error.message}`));
  return { worker, events };
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await Bun.sleep(10);
}

describe('worker group value poison', () => {
  test('a poison group value in the buffer does not FAIL a successful job', async () => {
    const broker = startFakeBroker([
      { id: 'good-1', data: { g: 'a' } },
      { id: 'poison-2', data: { g: { toString: 'x' } } },
    ]);
    const { worker, events } = createWorker(broker.server.port, 2, () => ({ ok: true }));
    try {
      worker.run();
      await waitFor(() => broker.failed.length > 0 || broker.acked.length === 2, 3_000);
    } finally {
      await worker.close(true);
      broker.server.stop(true);
      closeAllSharedPools();
    }

    expect({ failed: broker.failed, acked: [...broker.acked].sort() }).toEqual({
      failed: [],
      acked: ['good-1', 'poison-2'],
    });
    expect(events.filter((event) => !event.startsWith('completed'))).toEqual([]);
    expect(events).toContain('completed good-1');
    expect(events).toContain('completed poison-2');
  });

  test('the concurrency setter does not throw while a poison job is buffered', async () => {
    const blockGate = Promise.withResolvers<undefined>();
    const blockRunning = Promise.withResolvers<undefined>();
    const broker = startFakeBroker([
      { id: 'fast-1', data: { g: 'b' } },
      { id: 'block-2', data: { g: { toString: 'x' } } },
      { id: 'poison-3', data: { g: { toString: 'y' } } },
    ]);
    // Keep the first ACK pending so the setter must evaluate the ACK ceiling
    // while poison-3 is still buffered behind block-2's group.
    const constants = WORKER_CONSTANTS as { DEFAULT_ACK_INTERVAL: number };
    const originalInterval = constants.DEFAULT_ACK_INTERVAL;
    constants.DEFAULT_ACK_INTERVAL = 5_000;
    let created: ReturnType<typeof createWorker>;
    try {
      created = createWorker(broker.server.port, 3, async (id) => {
        if (id === 'block-2') {
          blockRunning.resolve(undefined);
          await blockGate.promise;
        }
        return { ok: true };
      });
    } finally {
      constants.DEFAULT_ACK_INTERVAL = originalInterval;
    }
    const { worker, events } = created;
    const internals = worker as unknown as { ackBatcher: { hasPending(): boolean } };

    let setterError: unknown = null;
    let pendingDuringSetter = false;
    try {
      worker.run();
      await Promise.race([blockRunning.promise, Bun.sleep(1_000)]);
      await waitFor(() => internals.ackBatcher.hasPending(), 1_000);
      pendingDuringSetter = internals.ackBatcher.hasPending();
      try {
        worker.concurrency = 5;
      } catch (error) {
        setterError = error;
      }
      blockGate.resolve(undefined);
      await waitFor(() => broker.failed.length > 0 || broker.acked.length === 3, 3_000);
    } finally {
      blockGate.resolve(undefined);
      await worker.close(true);
      broker.server.stop(true);
      closeAllSharedPools();
    }

    expect(setterError).toBeNull();
    expect(pendingDuringSetter).toBe(true);
    expect({ failed: broker.failed, acked: [...broker.acked].sort() }).toEqual({
      failed: [],
      acked: ['block-2', 'fast-1', 'poison-3'],
    });
    expect(events.filter((event) => !event.startsWith('completed'))).toEqual([]);
  });

  test('AckBatcher keeps a queued ACK when the dynamic ceiling throws', async () => {
    const sent: Record<string, unknown>[] = [];
    const reported: Error[] = [];
    const tcp: TcpConnection = {
      send: async (command) => {
        sent.push(command);
        return { ok: true };
      },
    };
    const batcher = new AckBatcher({
      batchSize: 10,
      interval: 20,
      embedded: false,
      maxBatchSize: () => {
        throw new TypeError('ceiling exploded');
      },
      onThresholdError: (error) => reported.push(error),
    });
    batcher.setTcp(tcp);

    const acked = batcher.queue('job-1', { ok: true }, 'token-1');
    expect(() => batcher.notifyCapacityChanged()).not.toThrow();
    expect(await acked).toBe(true);
    expect(sent.map((command) => [command.cmd, command.ids, command.tokens])).toEqual([
      ['ACKB', ['job-1'], ['token-1']],
    ]);
    expect(reported.length).toBeGreaterThan(0);
    expect(reported.every((error) => error.message === 'ceiling exploded')).toBe(true);
  });
});

describe('GroupConcurrencyLimiter.getGroupValue', () => {
  const limiter = new GroupConcurrencyLimiter('g', 1);

  test('keeps existing keys for ordinary values', () => {
    const cases: Array<[unknown, string | null]> = [
      ['tenant-a', 'tenant-a'],
      ['', ''],
      [42, '42'],
      [1.5, '1.5'],
      [-0, '0'],
      [Number.NaN, 'NaN'],
      [true, 'true'],
      [false, 'false'],
      [10n, '10'],
      [{ tenant: 1 }, '[object Object]'],
      [[1, 'b'], '1,b'],
      [{ toString: () => 'custom' }, 'custom'],
      [null, null],
      [undefined, null],
    ];
    for (const [value, expected] of cases) {
      expect(limiter.getGroupValue(jobWith({ g: value }))).toBe(expected);
    }
    expect(limiter.getGroupValue(jobWith({ other: 'x' }))).toBeNull();
    expect(limiter.getGroupValue(jobWith(null))).toBeNull();
    expect(limiter.getGroupValue(jobWith('scalar'))).toBeNull();
  });

  test('never throws for hostile values and stays deterministic', () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const fail = (): never => {
      throw new Error('hostile');
    };
    const hostile: unknown[] = [
      { toString: 'x' },
      { toString: 'x', valueOf: 'y' },
      { toString: () => ({}), valueOf: () => ({}) },
      { toString: fail },
      Object.create(null),
      Symbol('group'),
      [{ toString: 'x' }],
      revoked.proxy,
      Object.defineProperty({ toString: 'x' }, Symbol.toStringTag, { get: fail }),
    ];
    for (const value of hostile) {
      const job = jobWith({ g: value });
      const first = limiter.getGroupValue(job);
      expect(typeof first).toBe('string');
      expect(limiter.getGroupValue(job)).toBe(first);
      expect(() => limiter.canProcess(job)).not.toThrow();
    }
    const throwingData = new Proxy({}, { get: fail });
    expect(typeof limiter.getGroupValue(jobWith(throwingData))).toBe('string');
  });

  test('hostile values balance group counts and stay ACK-frontier safe', () => {
    const tracker = new GroupConcurrencyLimiter('g', 1);
    const poison = jobWith({ g: { toString: 'x' } });
    tracker.increment(poison);
    expect(tracker.canProcess(poison)).toBe(false);
    const group = tracker.getGroupValue(poison) as string;
    expect(tracker.getGroupCount(group)).toBe(1);
    tracker.decrement(poison);
    expect(tracker.getGroupCount(group)).toBe(0);
    expect(tracker.canProcess(poison)).toBe(true);

    const count = countImmediatelyStartableAckDeliveries({
      activeExecutions: 0,
      concurrency: 4,
      running: true,
      closing: false,
      nativeBatch: false,
      rateSlots: Number.POSITIVE_INFINITY,
      deliveries: [
        { generation: 1, job: poison },
        { generation: 2, job: jobWith({ g: Symbol('s') }) },
        { generation: 3, job: jobWith({ g: 'a' }) },
      ],
      head: 0,
      isCurrent: () => true,
      groupLimiter: tracker,
    });
    expect(count).toBe(3);
  });
});
