import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { toPublicJob } from '../src/client/jobConversion';
import { waitJobUntilFinished } from '../src/client/jobWait';
import { createJob } from '../src/domain/job/create';
import { jobId } from '../src/domain/types/job';
import { CoreE2eHarness } from './core-e2e/support/harness';

// Contract gaps found by the skeptic review of the first jobWait.ts:
// - a TTL of 0 meant "wait forever" with QueueEvents but "time out at once" without;
// - a TCP state read answered with `ok: false` was taken as "not finished yet", so an
//   error such as a rejected token turned into a timeout or a wait that never settled;
// - a Job built without a wait callback resolved `undefined` instead of rejecting.

setDefaultTimeout(20_000);

let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function outcome(wait: Promise<unknown>): Promise<{ value: unknown } | { error: string }> {
  return wait.then(
    (value) => ({ value }),
    (error: unknown) => ({ error: (error as Error).message })
  );
}

const silentEvents = { on: () => undefined, off: () => undefined };

for (const mode of ['embedded', 'tcp'] as const) {
  describe(`a TTL of 0 means no timeout [${mode}]`, () => {
    test('with and without QueueEvents', async () => {
      harness = await CoreE2eHarness.start(mode, 'wait-ttl-zero');
      const queue = harness.queue('ttl-zero');
      const job = await queue.add('ttl-zero', {}, { durable: true });
      const waits = [job.waitUntilFinished(null, 0), queue.waitJobUntilFinished(job.id, null, 0)];
      const outcomes = Promise.all(waits.map(outcome));
      await Bun.sleep(300);

      harness.worker(queue.name, () => 'done');

      expect(await outcomes).toEqual([{ value: 'done' }, { value: 'done' }]);
    });
  });
}

describe('a TCP state read that the broker refuses', () => {
  const refusing = {
    send: (command: Record<string, unknown>) =>
      Promise.resolve(
        command.cmd === 'GetState'
          ? { ok: false, error: 'Not authenticated' }
          : { ok: true, completed: false }
      ),
  };

  test('rejects with the broker error instead of waiting', async () => {
    const started = performance.now();
    expect(
      await outcome(waitJobUntilFinished({ tcp: refusing }, 'job-1', silentEvents, 0))
    ).toEqual({ error: 'Not authenticated' });
    expect(await outcome(waitJobUntilFinished({ tcp: refusing }, 'job-1', null, 5_000))).toEqual({
      error: 'Not authenticated',
    });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('an unknown job is a deliberate "not found", not an error reply', async () => {
    const unknown = {
      send: () => Promise.resolve({ ok: true, state: 'unknown' }),
    };
    for (const events of [silentEvents, null]) {
      expect(await outcome(waitJobUntilFinished({ tcp: unknown }, 'job-1', events, 5_000))).toEqual(
        { error: 'Job job-1 not found' }
      );
    }
  });
});

test('over TCP a missing job lets events already sent arrive before "not found"', async () => {
  // A job removed on completion reads as missing while its `completed` event may still
  // be on the event connection. The second waitUntilReady() is that connection's round
  // trip: the broker sent the event before it, so the event arrives first.
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  let readyCalls = 0;
  const events = {
    on(event: string, listener: (data: unknown) => void) {
      listeners.set(event, (listeners.get(event) ?? new Set()).add(listener));
    },
    off(event: string, listener: (data: unknown) => void) {
      listeners.get(event)?.delete(listener);
    },
    waitUntilReady() {
      if (++readyCalls === 2) {
        for (const listener of listeners.get('completed') ?? []) {
          listener({ jobId: 'job-1', returnvalue: 'done' });
        }
      }
      return Promise.resolve();
    },
  };
  const tcp = { send: () => Promise.resolve({ ok: true, state: 'unknown' }) };

  expect(await outcome(waitJobUntilFinished({ tcp }, 'job-1', events, 5_000))).toEqual({
    value: 'done',
  });
  expect(readyCalls).toBe(2);
});

test('an emitter that refuses the hint events still settles the wait and is left clean', async () => {
  // Shared listeners also subscribe to `stalled` and `removed`; an emitter that only
  // knows `completed` and `failed` must keep working as before.
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const strict = {
    on(event: string, listener: (data: unknown) => void) {
      if (event !== 'completed' && event !== 'failed') throw new Error(`unknown event ${event}`);
      listeners.set(event, (listeners.get(event) ?? new Set()).add(listener));
    },
    off(event: string, listener: (data: unknown) => void) {
      if (event !== 'completed' && event !== 'failed') throw new Error(`unknown event ${event}`);
      listeners.get(event)?.delete(listener);
    },
  };
  const tcp = { send: () => Promise.resolve({ ok: true, state: 'active' }) };
  setTimeout(() => {
    for (const listener of listeners.get('completed') ?? []) {
      listener({ jobId: 'job-1', returnvalue: 'done' });
    }
  }, 20);

  expect(await outcome(waitJobUntilFinished({ tcp }, 'job-1', strict, 5_000))).toEqual({
    value: 'done',
  });
  expect([...listeners.values()].reduce((count, set) => count + set.size, 0)).toBe(0);
});

test('a broker that answers WaitJob before the hold ends does not make the wait spin', async () => {
  const sent: string[] = [];
  const eager = {
    send: (command: Record<string, unknown>) => {
      sent.push(command.cmd as string);
      return Promise.resolve({ ok: true, state: 'waiting', completed: false });
    },
  };

  expect(await outcome(waitJobUntilFinished({ tcp: eager }, 'job-1', null, 1_500))).toEqual({
    error: 'waitUntilFinished timed out after 1500ms',
  });
  // Read first, then holds of 1000 and 500 ms (a timer firing a millisecond early may
  // add one more short hold), a scheduled read about 1 s in and one more read at the
  // deadline: a handful of commands, not a busy loop.
  expect(sent[0]).toBe('GetState');
  expect(sent.filter((cmd) => cmd === 'WaitJob').length).toBeLessThanOrEqual(3);
  expect(sent.length).toBeLessThanOrEqual(7);
});

test('a Job without a wait callback rejects instead of resolving undefined', async () => {
  const job = toPublicJob({ job: createJob(jobId('job-1'), 'q', { data: {} }), name: 'detached' });

  expect(await outcome(job.waitUntilFinished(null, 1_000))).toEqual({
    error: 'waitUntilFinished: no connection',
  });
});
