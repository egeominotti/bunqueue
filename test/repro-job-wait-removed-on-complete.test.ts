/**
 * Repro: a TCP wait without QueueEvents rejected with `Job <id> not found` for a job
 * that completed while it waited, when the job was removed on completion.
 *
 * Found through `postgres-public-api-extreme > resolves 256 remote waiters after a
 * removeOnComplete transaction`, which flaked under load. Each connection leases at
 * most 40 WaitJob hold slots, so with 64 waits per connection 24 waited for a slot and
 * learned of the outcome only from their scheduled GetState reads (about 1 s, then
 * 2 s ...). When the completion landed after the first hold window, a read could run
 * after `removeOnComplete` deleted the row: GetState answered `unknown` and the reader
 * settled the wait as missing, although the broker still held the result (a
 * PostgreSQL completion tombstone) and a WaitJob on that broker returned it. The two
 * read paths disagreed, so the outcome depended on which one ran first.
 *
 * A first read can also be served after the completion although the wait was sent
 * while the job ran (256 concurrent reads queue on four connections), so a reader
 * that finds no job now always asks WaitJob with a 0 ms hold, the broker's own
 * completion lookup, before it settles as missing. Memory and SQLite retain nothing
 * for a job removed on completion, so such a job still settles as missing there
 * (repro-wait-real-outcome.test.ts keeps that contract).
 */
import { describe, expect, test } from 'bun:test';
import { waitJobUntilFinished } from '../src/client/jobWait';
import { brokerReader } from '../src/client/job-wait/readers';
import type { CommandTransport } from '../src/client/job-wait/types';

type Reply = Record<string, unknown>;

interface FakeBroker extends CommandTransport {
  /** The job's state as GetState reports it. */
  state: string;
  /** What the broker retains once the job is gone: a completion result, or nothing. */
  retained: { result: unknown } | null;
  readonly commands: string[];
}

/** A broker whose WaitJob holds never complete: only reads can settle the wait. */
function fakeBroker(state: string, retained: FakeBroker['retained']): FakeBroker {
  const broker: FakeBroker = {
    state,
    retained,
    commands: [],
    async send(command: Record<string, unknown>): Promise<Reply> {
      broker.commands.push(`${String(command.cmd)}:${String(command.timeout ?? '')}`);
      if (command.cmd === 'GetState') return { ok: true, state: broker.state };
      if (command.cmd === 'WaitJob' && command.timeout === 0) {
        if (broker.state !== 'unknown') return { ok: true, completed: false };
        return broker.retained
          ? { ok: true, completed: true, result: broker.retained.result }
          : { ok: false, error: 'Job not found' };
      }
      if (command.cmd === 'WaitJob') return await new Promise<Reply>(() => undefined);
      return { ok: false, error: `unexpected ${String(command.cmd)}` };
    },
  };
  return broker;
}

describe('a job removed on completion while a TCP wait reads it', () => {
  test('the reader returns the retained result for a job it saw before', async () => {
    const broker = fakeBroker('active', { result: 77 });
    const reader = brokerReader(broker, 'job-1');

    expect(await reader.read()).toBeNull();
    broker.state = 'unknown';

    expect(await reader.read()).toEqual({ value: 77 });
  });

  test('a wait without QueueEvents settles on the result, not on "not found"', async () => {
    const broker = fakeBroker('active', { result: 77 });
    const wait = waitJobUntilFinished({ tcp: broker }, 'job-2', null, 15_000);
    await Bun.sleep(20);
    // Completed and removed on completion while the wait holds without a reply.
    broker.state = 'unknown';

    // The scheduled read (about 1 s in) decides.
    expect(await wait).toBe(77);
  });

  test('a job removed without a retained completion still settles as missing', async () => {
    const broker = fakeBroker('active', null);
    const reader = brokerReader(broker, 'job-3');

    expect(await reader.read()).toBeNull();
    broker.state = 'unknown';
    const outcome = await reader.read();

    expect(outcome).toMatchObject({ missing: true });
    expect((outcome as { error: Error }).error.message).toBe('Job job-3 not found');
  });

  test('a first read served after the completion settles on the retained result', async () => {
    // The wait was sent while the job ran; its first GetState reached the broker late.
    const broker = fakeBroker('unknown', { result: 77 });

    expect(await waitJobUntilFinished({ tcp: broker }, 'job-4', null, 15_000)).toBe(77);
    expect(broker.commands).toEqual(['GetState:', 'WaitJob:0']);
  });

  test('a job gone without a retained completion still settles as missing at once', async () => {
    const broker = fakeBroker('unknown', null);

    await expect(waitJobUntilFinished({ tcp: broker }, 'job-6', null, 15_000)).rejects.toThrow(
      'Job job-6 not found'
    );
    expect(broker.commands).toEqual(['GetState:', 'WaitJob:0']);
  });

  test('a transient refusal of the lookup is retried, not reported as missing', async () => {
    const broker = fakeBroker('active', { result: 77 });
    const reader = brokerReader(broker, 'job-5');
    expect(await reader.read()).toBeNull();
    broker.state = 'unknown';
    const send = broker.send.bind(broker);
    broker.send = async (command) =>
      command.cmd === 'WaitJob' ? { ok: false, error: 'Rate limit exceeded' } : await send(command);

    await expect(reader.read()).rejects.toThrow('Rate limit exceeded');
  });
});
