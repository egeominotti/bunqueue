/**
 * `SubscribeEvents` optional `eventTypes` filter: shape validation, broker fan-out
 * (an unfiltered connection keeps exactly its previous bytes and one write per batch;
 * a filtered one gets only its accepted frames, in batch order, and no write when
 * none match; unwanted events are never encoded), re-subscribe replacing the filter,
 * and a real TCP Worker that subscribes for `stalled` only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { JobEvent } from '../src/domain/types/queue';
import { QueueManager } from '../src/application/queueManager';
import { Queue, QueueEvents, Worker } from '../src/client';
import { createTcpServer, type TcpServer } from '../src/infrastructure/server/tcp';
import { TcpConnectionRegistry } from '../src/infrastructure/server/tcp/connections';
import { validateEventTypes } from '../src/infrastructure/server/tcp/eventFanout';
import { decodeMessagePack } from '../src/shared/msgpack';

type Single = (event: JobEvent) => void;
type Batch = (events: readonly JobEvent[]) => void;

interface FakeSocket {
  data: { eventTypes?: ReadonlySet<string> | null } & Record<string, unknown>;
  writes: Uint8Array[];
  write(bytes: Uint8Array): number;
  terminate(): void;
}

function harness() {
  const bridge: { single: Single | null; batch: Batch | null } = { single: null, batch: null };
  const queueManager = {
    subscribe(single: Single, batch: Batch) {
      bridge.single = single;
      bridge.batch = batch;
      return () => undefined;
    },
    emitDashboardEvent() {},
  };
  const registry = new TcpConnectionRegistry(queueManager as never, new Set(), 0, 0);
  const socket = (): FakeSocket => {
    const s = {
      data: undefined as unknown as FakeSocket['data'],
      writes: [] as Uint8Array[],
      write(bytes: Uint8Array) {
        s.writes.push(Uint8Array.from(bytes));
        return bytes.length;
      },
      terminate() {},
    };
    registry.init(s as never);
    return s;
  };
  const subscribe = (s: FakeSocket, queue: string, eventTypes?: string[] | null) =>
    registry.subscribeEvents(s as never, queue, eventTypes);
  return { bridge, registry, socket, subscribe };
}

function decoded(writes: Uint8Array[]): string[] {
  const out: string[] = [];
  for (const chunk of writes) {
    let offset = 0;
    while (offset < chunk.length) {
      const length = new DataView(chunk.buffer, chunk.byteOffset + offset, 4).getUint32(0);
      const frame = decodeMessagePack<{ event: JobEvent }>(
        chunk.subarray(offset + 4, offset + 4 + length)
      );
      out.push(`${frame.event.eventType}:${String(frame.event.jobId)}`);
      offset += 4 + length;
    }
  }
  return out;
}

const event = (eventType: string, jobId: string, queue = 'q'): JobEvent =>
  ({
    queue,
    eventType,
    jobId,
    timestamp: 1_700_000_000_000,
    data: { n: jobId },
  }) as unknown as JobEvent;

const batch = [
  event('pulled', '1'),
  event('stalled', '2'),
  event('completed', '1'),
  event('stalled', '4'),
  event('failed', '6'),
];

describe('eventTypes validation', () => {
  test('accepts absent, null and 1..32 names of 1..64 characters', () => {
    expect(validateEventTypes(undefined)).toBeNull();
    expect(validateEventTypes(null)).toBeNull();
    expect(validateEventTypes(['stalled'])).toBeNull();
    expect(validateEventTypes(Array.from({ length: 32 }, (_, i) => `t${i}`))).toBeNull();
    expect(validateEventTypes(['x'.repeat(64)])).toBeNull();
  });

  test('refuses every other shape', () => {
    for (const value of [
      [],
      Array.from({ length: 33 }, (_, i) => `t${i}`),
      [''],
      ['x'.repeat(65)],
      7,
      'stalled',
      [['stalled']],
      [1],
      { 0: 'stalled', length: 1 },
    ]) {
      expect(validateEventTypes(value)).toBeString();
    }
  });
});

describe('broker fan-out with eventTypes', () => {
  test('an unfiltered connection keeps its bytes and its single write next to filtered ones', () => {
    const plain = harness();
    const reference = plain.socket();
    plain.subscribe(reference, 'q');
    plain.bridge.batch!(batch);

    const mixed = harness();
    const unfiltered = mixed.socket();
    const stalledOnly = mixed.socket();
    const nothing = mixed.socket();
    mixed.subscribe(unfiltered, 'q');
    mixed.subscribe(stalledOnly, 'q', ['stalled']);
    mixed.subscribe(nothing, 'q', ['drained']);
    mixed.bridge.batch!(batch);

    expect(unfiltered.writes).toHaveLength(1);
    expect(Array.from(unfiltered.writes[0])).toEqual(Array.from(reference.writes[0]));
    expect(stalledOnly.writes).toHaveLength(1);
    expect(decoded(stalledOnly.writes)).toEqual(['stalled:2', 'stalled:4']);
    expect(nothing.writes).toHaveLength(0);

    mixed.bridge.single!(event('stalled', '9'));
    mixed.bridge.single!(event('pulled', '10'));
    expect(decoded(stalledOnly.writes.slice(1))).toEqual(['stalled:9']);
    expect(decoded(unfiltered.writes.slice(1))).toEqual(['stalled:9', 'pulled:10']);
    expect(nothing.writes).toHaveLength(0);
  });

  test('an event no subscriber accepts is never encoded', () => {
    const h = harness();
    const stalledOnly = h.socket();
    h.subscribe(stalledOnly, 'q', ['stalled']);
    let reads = 0;
    const spied = (eventType: string, jobId: string) => {
      const value = { queue: 'q', eventType, jobId, timestamp: 1 } as Record<string, unknown>;
      Object.defineProperty(value, 'data', {
        enumerable: true,
        get() {
          reads++;
          return { jobId };
        },
      });
      return value as unknown as JobEvent;
    };
    h.bridge.batch!([spied('pulled', '1'), spied('completed', '1')]);
    h.bridge.single!(spied('pulled', '2'));
    expect(reads).toBe(0);
    expect(stalledOnly.writes).toHaveLength(0);
  });

  test('re-subscribing replaces the filter and unsubscribing clears it', () => {
    const h = harness();
    const s = h.socket();
    h.subscribe(s, 'q', ['stalled']);
    h.subscribe(s, 'q', ['pulled']);
    h.bridge.batch!([event('stalled', '1'), event('pulled', '2')]);
    expect(decoded(s.writes)).toEqual(['pulled:2']);

    s.writes = [];
    h.subscribe(s, 'q', null);
    h.bridge.batch!([event('stalled', '3'), event('pulled', '4')]);
    expect(decoded(s.writes)).toEqual(['stalled:3', 'pulled:4']);

    h.subscribe(s, 'q', ['stalled']);
    h.registry.unsubscribeEvents(s as never);
    expect(s.data.eventTypes ?? null).toBeNull();
  });
});

describe('TCP Worker subscribes for stalled only', () => {
  const cleanups: Array<() => unknown> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  test('the worker event connection receives no pulled or completed frames', async () => {
    const qm = new QueueManager();
    const server: TcpServer = createTcpServer(qm, { hostname: '127.0.0.1', port: 0 });
    cleanups.push(
      () => qm.shutdown(),
      () => server.stop()
    );
    const connection = { host: '127.0.0.1', port: server.server.port };
    const name = `event-filter-${process.pid}`;

    const listener = new QueueEvents(name, { embedded: false, connection });
    cleanups.push(() => listener.close());
    await listener.waitUntilReady();
    let completedSeen = 0;
    listener.on('completed', () => completedSeen++);

    let processed = 0;
    const worker = new Worker(name, () => ++processed, {
      embedded: false,
      connection,
      concurrency: 10,
    });
    cleanups.push(() => worker.close(true));
    await worker.waitUntilReady();
    const subscription = (
      worker as unknown as {
        stalledSubscription: { client: { on: (e: string, fn: () => void) => void } };
      }
    ).stalledSubscription;
    let workerFrames = 0;
    subscription.client.on('queueEvent', () => workerFrames++);

    const queue = new Queue(name, { embedded: false, connection });
    cleanups.push(() => queue.close());
    await queue.addBulk(Array.from({ length: 50 }, (_, i) => ({ name: 'j', data: { i } })));
    const deadline = Date.now() + 5_000;
    while ((processed < 50 || completedSeen < 50) && Date.now() < deadline) await Bun.sleep(20);

    expect(processed).toBe(50);
    expect(completedSeen).toBe(50); // an unfiltered subscriber still sees everything
    expect(workerFrames).toBe(0);
  });
});
