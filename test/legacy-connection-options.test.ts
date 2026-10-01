/**
 * bunqueue-client 0.1.x accepted flat connection options (`host`, `port`,
 * `token`, `tls`). The canonical client never reads them at the top level, so
 * a migrated caller would silently connect to localhost:6789 without its token
 * or TLS. Every TCP-connecting class must reject them with a clear message.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  Bunqueue,
  FlowProducer,
  Queue,
  QueueEvents,
  QueueGroup,
  SandboxedWorker,
  Worker,
  shutdownManager,
} from '../src/client';
import { Engine } from '../src/client/workflow';

// The portable bunqueue-client bundle is built from the same canonical source.
const portable =
  (await import('../sdk/typescript/dist/index.js')) as typeof import('../src/client');

const MIGRATE = /connection: \{ host, port, token, tls \}/;
const processor = async () => 'ok';
// Loose objects model JavaScript callers and casts that bypass excess-property checks.
const flat = (extra: Record<string, unknown>) => extra as Record<string, never>;

afterAll(() => shutdownManager());

describe('flat 0.1.x connection options are rejected in TCP mode', () => {
  const constructors: Array<[string, (options: Record<string, never>) => unknown]> = [
    ['Queue', (options) => new Queue('legacy-flat', options)],
    ['Worker', (options) => new Worker('legacy-flat', processor, options)],
    ['FlowProducer', (options) => new FlowProducer(options)],
    ['QueueEvents', (options) => new QueueEvents('legacy-flat', options)],
    ['Bunqueue', (options) => new Bunqueue('legacy-flat', { processor, ...options })],
    ['QueueGroup.getQueue', (options) => new QueueGroup('legacy').getQueue('flat', options)],
    [
      'QueueGroup.getWorker',
      (options) => new QueueGroup('legacy').getWorker('flat', processor, options),
    ],
    [
      'SandboxedWorker',
      (options) => new SandboxedWorker('legacy-flat', { processor: '/p.mjs', ...options }),
    ],
    ['Engine', (options) => new Engine(options)],
    ['bunqueue-client Queue', (options) => new portable.Queue('legacy-flat', options)],
    ['bunqueue-client Worker', (options) => new portable.Worker('legacy-flat', processor, options)],
  ];

  for (const [name, create] of constructors) {
    test(`${name} names the flat keys and the connection object`, () => {
      const options = flat({ embedded: false, host: 'broker.internal', port: 7000, token: 't' });
      expect(() => create(options)).toThrow(MIGRATE);
      expect(() => create(options)).toThrow(/host, port, token/);
    });
  }

  test.each(['host', 'port', 'token', 'tls'])('a lone top-level %s is rejected', (key) => {
    expect(() => new Queue('legacy-flat', flat({ embedded: false, [key]: 1 }))).toThrow(
      new RegExp(`top-level ${key} `)
    );
  });
});

describe('valid options are unaffected', () => {
  test('connection-scoped options construct a TCP queue', async () => {
    const queue = new Queue('legacy-ok', {
      embedded: false,
      connection: { host: '127.0.0.1', port: 1, token: 't', tls: false },
    });
    await queue.close();
  });

  test('explicit embedded mode ignores unrelated top-level keys', async () => {
    const queue = new Queue('legacy-embedded', flat({ embedded: true, host: 'ignored' }));
    await queue.close();
  });

  test('keys explicitly set to undefined are not treated as legacy options', async () => {
    const worker = new Worker(
      'legacy-undefined',
      processor,
      flat({ embedded: false, autorun: false, host: undefined, token: undefined })
    );
    await worker.close();
  });
});
