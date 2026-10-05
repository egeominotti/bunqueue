/**
 * Repro: `autoBatch` options are not validated and the batcher arms a raw timer.
 *
 * `new Queue(name, { autoBatch: { maxDelayMs } })` passed any value to
 * `setTimeout`, which the runtime rewrites to ~1 ms when it is NaN, negative or above
 * 2^31 - 1: a long batching window flushed almost at once and printed a
 * TimeoutOverflowWarning. `maxSize` accepted NaN, which silently disabled the size
 * threshold. The Queue constructor now validates both, and the batcher's window
 * timer is a safe timer.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { AddBatcher, type FlushCallback } from '../src/client/queue/addBatcher';
import { Queue } from '../src/client';
import type { Job } from '../src/client/types';

const queues: Queue[] = [];

afterEach(async () => {
  for (const queue of queues.splice(0)) await queue.close();
});

function tcpQueue(autoBatch: Record<string, unknown>): Queue {
  const queue = new Queue('autobatch-options', {
    embedded: false,
    connection: { host: '127.0.0.1', port: 1, poolSize: 1 },
    autoBatch: autoBatch as never,
  });
  queues.push(queue);
  return queue;
}

describe('Queue validates autoBatch options', () => {
  test('values 2.9.10 read with a well-defined result keep it, and nothing throws', () => {
    // `pending >= maxSize` and a one-shot window timer: see
    // test/repro-compat-client-sandboxed-autobatch.test.ts and
    // test/repro-compat-client-pull-quiet.test.ts.
    for (const autoBatch of [
      { maxDelayMs: Number.NaN },
      { maxDelayMs: -1 },
      { maxDelayMs: '5' },
      { maxDelayMs: Infinity },
      { maxDelayMs: 'soon' },
      { maxSize: Number.NaN },
      { maxSize: 0 },
      { maxSize: 2.5 },
      { maxSize: '50' },
      { maxSize: 'many' },
      { maxSize: 2 ** 53 },
      { enabled: 'false' },
    ]) {
      expect(() => tcpQueue(autoBatch)).not.toThrow();
    }
  });

  test('accepts the documented defaults and long windows', () => {
    expect(() => tcpQueue({ enabled: true, maxSize: 50, maxDelayMs: 5 })).not.toThrow();
    expect(() => tcpQueue({ maxDelayMs: 3e9 })).not.toThrow();
    expect(() => tcpQueue({ enabled: false, maxDelayMs: Number.NaN })).not.toThrow();
  });
});

describe('AddBatcher window timer', () => {
  test('a window above 2^31 - 1 ms does not flush after ~1 ms', async () => {
    const calls: Array<() => void> = [];
    const flush: FlushCallback<number> = (jobs) =>
      new Promise<Job<number>[]>((resolve) => {
        calls.push(() => resolve(jobs.map((job) => ({ id: job.name }) as Job<number>)));
      });
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(warning.name);
    process.on('warning', onWarning);
    const batcher = new AddBatcher<number>({ maxSize: 100, maxDelayMs: 3e9 }, flush);
    try {
      const first = batcher.enqueue('a', 1);
      const second = batcher.enqueue('b', 2);
      await Bun.sleep(30);
      expect(calls.length).toBe(1);
      calls[0]();
      await first;
      await Bun.sleep(0);
      expect(calls.length).toBe(2);
      calls[1]();
      await second;
      expect(warnings.filter((name) => name.startsWith('Timeout'))).toEqual([]);
    } finally {
      process.off('warning', onWarning);
      batcher.stop();
    }
  });
});
