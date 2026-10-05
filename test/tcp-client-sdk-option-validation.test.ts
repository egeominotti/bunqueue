import { afterAll, expect, test } from 'bun:test';
import {
  FlowProducer,
  Queue,
  QueueEvents,
  SandboxedWorker,
  shutdownManager,
  Worker,
} from '../src/client';
import { closeAllSharedPools } from '../src/client/tcpPool';

// Every class that opens a TCP connection rejects an invalid connection duration when
// it is constructed, whichever path builds the connection: the shared pool (a default
// Queue or FlowProducer, a SandboxedWorker), a dedicated pool (a Queue with another
// poolSize, a Worker) or a dedicated client (QueueEvents, and the Worker's stalled
// subscription, which reuses the connection options its pool already validated).

afterAll(() => {
  closeAllSharedPools();
  shutdownManager();
});

const connection = { host: '127.0.0.1', port: 1, pingInterval: Number.NaN };
const processor = async () => null;

/** Each built object closes with `close()`, or `stop()` for a SandboxedWorker. */
type Built = { close?: () => unknown; stop?: () => unknown };

const builders: Array<[string, () => Built]> = [
  ['Queue (shared pool)', () => new Queue('tcp-validation', { embedded: false, connection })],
  [
    'Queue (dedicated pool)',
    () =>
      new Queue('tcp-validation', { embedded: false, connection: { ...connection, poolSize: 2 } }),
  ],
  [
    'Worker',
    () => new Worker('tcp-validation', processor, { embedded: false, autorun: false, connection }),
  ],
  ['FlowProducer', () => new FlowProducer({ embedded: false, connection })],
  ['QueueEvents', () => new QueueEvents('tcp-validation', { connection })],
  [
    'SandboxedWorker',
    () => new SandboxedWorker('tcp-validation', { processor: '/p.mjs', connection }),
  ],
];

test.each(builders)('%s rejects a NaN pingInterval at construction', (_, build) => {
  let built: Built | undefined;
  try {
    expect(() => {
      built = build();
    }).toThrow(/pingInterval must be a finite number of milliseconds/);
  } finally {
    // Only reached with an object when the constructor wrongly accepted the value.
    void Promise.resolve()
      .then(() => (built?.close ?? built?.stop)?.call(built))
      .catch(() => undefined);
  }
});
