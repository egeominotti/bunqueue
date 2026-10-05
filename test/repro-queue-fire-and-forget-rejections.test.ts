/**
 * Repro: the synchronous Queue mutators (pause(), setGlobalRateLimit(), purgeDlq(),
 * setDlqConfig() ...) sent their TCP command without awaiting it and without a
 * rejection handler. With the broker unreachable, the command timed out (or, after
 * close(), the pool refused it) and the promise rejected unhandled, which ends a Bun
 * process. Simple Mode hit it from its constructor (`dlq` option) and from trigger
 * rules, and `job.discard()` hit it too. Every such failure must be handled and
 * observable: on Simple Mode's `error` event while a listener is attached, otherwise
 * as one console.error line naming the command and the queue. A command rejected only
 * because the caller closed the client stays silent.
 *
 * The broker is a port nothing listens on, and a 100 ms commandTimeout makes every
 * queued command fail quickly. `embedded: false` is explicit because the test preload
 * forces embedded mode. Bun's test runner fails a file on an unhandled rejection even
 * with a process listener attached, so both signals catch a regression.
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Bunqueue } from '../src/client/bunqueue';
import { createDlqJobMethods } from '../src/client/queue/dlqJobMethods';
import { createJobProxy } from '../src/client/queue/job-proxy/tcp';
import { createSimpleJob } from '../src/client/queue/job-proxy/simple';
import { Queue } from '../src/client/queue/queue';
import { TcpConnectionPool } from '../src/client/tcpPool';
import { closedPort } from './tcp-client-support';

const COMMAND_TIMEOUT = 100;
/** Long enough for every queued command to hit its timeout and be reported. */
const SETTLE_MS = COMMAND_TIMEOUT * 4;

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
let errorLog: ReturnType<typeof spyOn>;
const closers: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
  errorLog = spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  // Let the rejections of the commands close() cancelled surface before checking.
  await Bun.sleep(10);
  process.off('unhandledRejection', onUnhandled);
  errorLog.mockRestore();
});

const connection = () => ({ port: closedPort(), commandTimeout: COMMAND_TIMEOUT, poolSize: 1 });

function deadQueue(name: string): Queue {
  const queue = new Queue(name, { embedded: false, connection: connection() });
  closers.push(() => queue.close());
  return queue;
}

function deadPool(): TcpConnectionPool {
  const pool = new TcpConnectionPool(connection());
  closers.push(() => pool.close());
  return pool;
}

function deadApp(name: string): Bunqueue {
  const app = new Bunqueue(name, {
    embedded: false,
    connection: connection(),
    autorun: false,
    processor: async () => ({}),
    dlq: { maxEntries: 5 },
  });
  closers.push(() => app.close(true));
  return app;
}

/** The console.error lines reporting `command` for `queue`. */
function logLines(command: string, queue: string): string[] {
  return errorLog.mock.calls
    .map((args: unknown[]) => args.map(String).join(' '))
    .filter((line: string) => line.includes(` ${command} `) && line.includes(`"${queue}"`));
}

const SYNC_MUTATORS: Array<[string, (queue: Queue) => unknown]> = [
  ['SetDlqConfig', (queue) => queue.setDlqConfig({ maxEntries: 10 })],
  ['RetryDlq', (queue) => queue.retryDlq()],
  ['PurgeDlq', (queue) => queue.purgeDlq()],
  ['RetryCompleted', (queue) => queue.retryCompleted()],
  ['SetConcurrency', (queue) => queue.setGlobalConcurrency(2)],
  ['ClearConcurrency', (queue) => queue.removeGlobalConcurrency()],
  ['RateLimit', (queue) => queue.setGlobalRateLimit(5, 1000)],
  ['RateLimitClear', (queue) => queue.removeGlobalRateLimit()],
  ['SetStallConfig', (queue) => queue.setStallConfig({ stallInterval: 1000 })],
  ['Pause', (queue) => queue.pause()],
  ['Resume', (queue) => queue.resume()],
  ['Drain', (queue) => queue.drain()],
  ['Obliterate', (queue) => queue.obliterate()],
  ['Cancel', (queue) => queue.remove('job-1')],
];

for (const [command, call] of SYNC_MUTATORS) {
  test(`${command}: an unreachable broker is reported once, not rejected unhandled`, async () => {
    const queue = deadQueue(`ff-${command}`);
    call(queue);
    await Bun.sleep(SETTLE_MS);
    expect(unhandled).toEqual([]);
    expect(logLines(command, `ff-${command}`)).toHaveLength(1);
  });
}

test('retryDlqByFilter reports its failure instead of swallowing it', async () => {
  const queue = deadQueue('ff-filter');
  queue.retryDlqByFilter({ reason: 'timeout' });
  await Bun.sleep(SETTLE_MS);
  expect(unhandled).toEqual([]);
  expect(logLines('RetryDlq', 'ff-filter')).toHaveLength(1);
});

test('a mutator called after close() reports the closed pool', async () => {
  const queue = deadQueue('ff-closed');
  queue.close();
  queue.pause();
  queue.setGlobalRateLimit(1);
  await Bun.sleep(20);
  expect(unhandled).toEqual([]);
  const [pauseLine] = logLines('Pause', 'ff-closed');
  expect(pauseLine).toContain('Connection pool is closed');
  expect(logLines('RateLimit', 'ff-closed')).toHaveLength(1);
});

test('a command cancelled by the caller closing the queue stays silent', async () => {
  const queue = deadQueue('ff-cancelled');
  queue.pause();
  queue.purgeDlq();
  queue.close();
  await Bun.sleep(20);
  expect(unhandled).toEqual([]);
  expect(logLines('Pause', 'ff-cancelled')).toEqual([]);
  expect(logLines('PurgeDlq', 'ff-cancelled')).toEqual([]);
});

test('Simple Mode routes background failures to its error event while a listener is attached', async () => {
  const app = deadApp('ff-simple'); // the `dlq` option sends SetDlqConfig from the constructor
  const errors: Array<Error & { command?: string; queue?: string }> = [];
  app.on('error', (error) => errors.push(error));
  app.setGlobalRateLimit(3);
  app.purgeDlq();
  app.pause();
  await Bun.sleep(SETTLE_MS);
  expect(unhandled).toEqual([]);
  const commands = errors.filter((error) => error.queue === 'ff-simple').map((e) => e.command);
  expect(commands.sort((a, b) => String(a).localeCompare(String(b)))).toEqual([
    'Pause',
    'PurgeDlq',
    'RateLimit',
    'SetDlqConfig',
  ]);
  expect(logLines('SetDlqConfig', 'ff-simple')).toEqual([]);
});

test('Simple Mode without an error listener logs its background failures', async () => {
  const app = deadApp('ff-simple-log');
  app.removeGlobalRateLimit();
  await Bun.sleep(SETTLE_MS);
  expect(unhandled).toEqual([]);
  expect(logLines('SetDlqConfig', 'ff-simple-log')).toHaveLength(1);
  expect(logLines('RateLimitClear', 'ff-simple-log')).toHaveLength(1);
});

test('an error listener that throws does not turn the failure into an unhandled rejection', async () => {
  const app = deadApp('ff-throwing-listener');
  app.on('error', () => {
    throw new Error('listener bug');
  });
  await Bun.sleep(SETTLE_MS);
  expect(unhandled).toEqual([]);
  expect(logLines('SetDlqConfig', 'ff-throwing-listener')).toHaveLength(1);
});

test('a trigger rule whose add fails reports it on the error event', async () => {
  const app = deadApp('ff-trigger');
  const errors: Array<Error & { command?: string; queue?: string }> = [];
  app.on('error', (error) => errors.push(error));
  app.trigger({ on: 'parent', create: 'child', data: () => ({}) });
  app.worker.emit('completed', { id: 'p1', name: 'parent' }, {});
  await Bun.sleep(SETTLE_MS);
  expect(unhandled).toEqual([]);
  expect(errors.some((error) => error.command === 'add' && error.queue === 'ff-trigger')).toBe(
    true
  );
});

test('job.discard() over an unreachable broker is reported, not rejected unhandled', async () => {
  const pool = deadPool();
  const noop = async () => undefined as never;
  const base = { getJobState: noop, removeAsync: noop, retryJob: noop, getChildrenValues: noop };
  createJobProxy('j1', 'n', {}, { ...base, queueName: 'ff-proxy', tcp: pool }).discard();
  createSimpleJob('j2', 'n', {}, Date.now(), {
    ...base,
    queueName: 'ff-simple-job',
    tcp: pool,
  }).discard();
  createDlqJobMethods({ ...base, name: 'ff-dlq-job', embedded: false, tcp: pool }).discard?.('j3');
  await Bun.sleep(SETTLE_MS);
  expect(unhandled).toEqual([]);
  expect(logLines('Discard', 'ff-proxy')).toHaveLength(1);
  expect(logLines('Discard', 'ff-simple-job')).toHaveLength(1);
  expect(logLines('Discard', 'ff-dlq-job')).toHaveLength(1);
});
