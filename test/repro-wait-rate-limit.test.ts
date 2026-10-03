import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, QueueEvents } from '../src/client';
import { waitJobUntilFinished } from '../src/client/jobWait';
import { QueueManager } from '../src/application/queueManager';
import { createTcpServer, type TcpServer } from '../src/infrastructure/server/tcp';

// Found by the skeptic review of the v2 job wait: every event-driven TCP wait re-read its
// job 5, 15 and 35 s after it started and then every 30 s, waits started together read in
// the same tick, and any failed re-read rejected the wait. The broker allows each
// connection 10,000 requests per 60 s, so 4,000 QueueEvents waits with a 20 s TTL had
// 2,001 rejected with "Rate limit exceeded" and a later queue.add failed too (HEAD let all
// of them reach their TTL). Re-reads are now budgeted per connection, jittered, and a
// transient failure (rate limit, timeout, lost connection) is retried instead of fatal.

setDefaultTimeout(60_000);

type Reply = Record<string, unknown>;

function outcome(wait: Promise<unknown>): Promise<{ value: unknown } | { error: string }> {
  return wait.then(
    (value) => ({ value }),
    (error: unknown) => ({ error: (error as Error).message })
  );
}

/** A QueueEvents double: `emit` delivers an event to the wait's listeners. */
function fakeEvents() {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(event: string, listener: (data: unknown) => void) {
      listeners.set(event, (listeners.get(event) ?? new Set()).add(listener));
    },
    off(event: string, listener: (data: unknown) => void) {
      listeners.get(event)?.delete(listener);
    },
    emit(event: string, data: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(data);
    },
  };
}

/** A transport double answering GetState from `states` in order (the last one repeats). */
function scriptedTransport(states: Array<Reply | Error>) {
  const reads: number[] = [];
  return {
    reads,
    send(command: Reply): Promise<Reply> {
      if (command.cmd === 'GetResult') return Promise.resolve({ ok: true, result: 'done' });
      if (command.cmd !== 'GetState') return Promise.resolve({ ok: true });
      reads.push(Date.now());
      const next = states[Math.min(reads.length - 1, states.length - 1)];
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
}

const waiting: Reply = { ok: true, state: 'waiting' };
const completed: Reply = { ok: true, state: 'completed' };

describe('a transient failure of a re-read does not reject the wait', () => {
  for (const [label, failure] of [
    ['a rate-limit refusal', { ok: false, error: 'Rate limit exceeded' }],
    ['a command timeout', new Error('Command timeout')],
    ['a lost connection', new Error('Connection lost')],
  ] as const) {
    test(label, async () => {
      const events = fakeEvents();
      const tcp = scriptedTransport([waiting, failure, completed]);
      const wait = outcome(waitJobUntilFinished({ tcp }, 'job-1', events, 0));
      await Bun.sleep(20);

      // A hint makes the wait read again: the second read fails, and the wait goes on.
      events.emit('stalled', { jobId: 'job-1' });
      expect(await Promise.race([wait, Bun.sleep(100).then(() => 'pending')])).toBe('pending');

      // The next read finds the result.
      events.emit('stalled', { jobId: 'job-1' });
      expect(await Promise.race([wait, Bun.sleep(3_000).then(() => 'pending')])).toEqual({
        value: 'done',
      });
      expect(tcp.reads.length).toBe(3);
    });
  }

  test('a permanent refusal of a re-read still rejects the wait', async () => {
    const events = fakeEvents();
    const tcp = scriptedTransport([waiting, { ok: false, error: 'Not authenticated' }]);
    const wait = outcome(waitJobUntilFinished({ tcp }, 'job-1', events, 0));
    await Bun.sleep(20);

    events.emit('stalled', { jobId: 'job-1' });

    expect(await wait).toEqual({ error: 'Not authenticated' });
  });

  test('a rate-limited first read is retried too', async () => {
    // HEAD let such a wait run on events (its state read swallowed the refusal): with
    // 14,000 waits on one connection, rejecting would turn 4,000 of them into errors.
    const refused = { ok: false, error: 'Rate limit exceeded' };
    const events = fakeEvents();
    const withEvents = scriptedTransport([refused, completed]);
    const wait = outcome(waitJobUntilFinished({ tcp: withEvents }, 'job-1', events, 0));
    await Bun.sleep(20);
    events.emit('stalled', { jobId: 'job-1' });
    expect(await wait).toEqual({ value: 'done' });

    // Without events the scheduled reads (1 s in, jittered) retry it.
    const withoutEvents = scriptedTransport([refused, completed]);
    expect(
      await outcome(waitJobUntilFinished({ tcp: withoutEvents }, 'job-1', null, 10_000))
    ).toEqual({ value: 'done' });
  });
});

test('waits started together spread their safety-net reads within a per-connection budget', async () => {
  const tcp = scriptedTransport([waiting]);
  const events = fakeEvents();
  const waits = Array.from({ length: 300 }, (_, i) =>
    outcome(waitJobUntilFinished({ tcp }, `job-${i}`, events, 9_000))
  );
  await Bun.sleep(50);
  const started = Date.now();
  expect(tcp.reads.length).toBe(300);

  await Promise.all(waits);
  const background = tcp.reads.slice(300).filter((at) => at >= started);
  const perSecond = new Map<number, number>();
  for (const at of background) {
    const second = Math.floor((at - started) / 1000);
    perSecond.set(second, (perSecond.get(second) ?? 0) + 1);
  }
  // Budget: about 20 re-reads per second per connection, never 300 in one tick.
  expect(Math.max(0, ...perSecond.values())).toBeLessThanOrEqual(45);
  expect(background.length).toBeLessThanOrEqual(220);
  // Jitter: the re-reads that did run are not all in the same instant.
  expect(Math.max(...background) - Math.min(...background)).toBeGreaterThanOrEqual(500);
});

describe('event-driven waits against the broker rate limiter', () => {
  let dir = '';
  let manager: QueueManager | null = null;
  let server: TcpServer | null = null;

  afterEach(() => {
    server?.stop();
    manager?.shutdown();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('4,000 QueueEvents waits on one connection reach their TTL and leave room for traffic', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wait-rate-limit-'));
    manager = new QueueManager({ dataPath: join(dir, 'q.db') });
    server = createTcpServer(manager, { hostname: '127.0.0.1', port: 0 });
    const connection = { host: '127.0.0.1', port: server.server.port, poolSize: 1 };
    // embedded: false is explicit, as the test preload sets BUNQUEUE_EMBEDDED=1.
    const queue = new Queue('rate-limited', {
      embedded: false,
      connection,
      autoBatch: { enabled: false },
    });
    const events = new QueueEvents('rate-limited', { embedded: false, connection });
    try {
      await events.waitUntilReady();
      const jobs = await queue.addBulk(
        Array.from({ length: 4_000 }, (_, i) => ({ name: 'job', data: { i } }))
      );

      const outcomes = await Promise.all(
        jobs.map((job) => outcome(queue.waitJobUntilFinished(job.id, events, 16_000)))
      );

      const summary: Record<string, number> = {};
      for (const result of outcomes) {
        const key = 'error' in result ? result.error.replace(/Job \S+ /, 'Job <id> ') : 'value';
        summary[key] = (summary[key] ?? 0) + 1;
      }
      expect(summary).toEqual({ 'Job <id> timed out after 16000ms': 4_000 });
      expect((await queue.add('after', {})).id).toBeString();
    } finally {
      events.close();
      await queue.close();
    }
  });
});
