/**
 * Mixed versions: a client of this release removing jobs on a 2.9.13 broker.
 *
 * A 2.9.13 broker (commit 8ef483e5, `handleCancel` in
 * src/infrastructure/server/handlers/management.ts) answered Cancel with
 * `Job not found or cannot be cancelled` whenever the engine removed nothing: for a
 * missing job, and also for an active, a failed and a completed one (that engine never
 * removed a completed job). The client took any "not found" as "missing", so a
 * FlowProducer job's `remove()`, which rejected on any refusal in 2.9.13, resolved on an
 * old broker without removing anything; `removeAsync()` and a processor job's `remove()`
 * resolved the same way. The legacy reply is now settled by a `GetState` on the same
 * transport: only `unknown` resolves, any other state rejects naming it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { createFlowJobObject } from '../src/client/flowJobFactory';
import { removeAsync } from '../src/client/queue/operations/management';
import type { TcpConnectionPool } from '../src/client/tcpPool';
import { createRemoveHandler } from '../src/client/worker/handlers/mutations';
import type { TcpConnection } from '../src/client/worker/types/transport';
import { CANCEL_JOB_NOT_FOUND_ERROR } from '../src/domain/job/cancellation';
import type { Command } from '../src/domain/types/command';
import { handleCommand } from '../src/infrastructure/server/handler';
import type { HandlerContext } from '../src/infrastructure/server/types';

/** The 2.9.13 Cancel refusal, verbatim (`git show 8ef483e5:...handlers/management.ts`). */
const LEGACY_REFUSAL = 'Job not found or cannot be cancelled';

interface FakeTransport {
  readonly sent: string[];
  send(command: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * Answers like a 2.9.13 broker: Cancel removes a pending job (`ok`) and refuses anything
 * else with the ambiguous legacy text; GetState answers `{ ok, id, state }`.
 */
function legacyBroker(states: Record<string, string>): FakeTransport {
  const jobs = new Map(Object.entries(states));
  const pending = new Set(['waiting', 'delayed', 'prioritized', 'waiting-children']);
  const sent: string[] = [];
  return {
    sent,
    send(command) {
      const id = String(command.id);
      const state = jobs.get(id) ?? 'unknown';
      sent.push(String(command.cmd));
      if (command.cmd === 'GetState') return Promise.resolve({ ok: true, id, state });
      if (command.cmd !== 'Cancel') return Promise.resolve({ ok: false, error: 'Unknown command' });
      if (!pending.has(state)) return Promise.resolve({ ok: false, error: LEGACY_REFUSAL });
      jobs.delete(id);
      return Promise.resolve({ ok: true });
    },
  };
}

/** Answers with this release's real command handler over a real engine. */
function currentBroker(manager: QueueManager): FakeTransport {
  const ctx: HandlerContext = {
    queueManager: manager,
    authTokens: new Set(),
    authenticated: false,
    clientId: 'mixed-version',
  };
  const sent: string[] = [];
  return {
    sent,
    async send(command) {
      sent.push(String(command.cmd));
      return (await handleCommand(command as unknown as Command, ctx)) as unknown as Record<
        string,
        unknown
      >;
    },
  };
}

type Remover = (transport: FakeTransport, id: string) => Promise<void>;

/** Every awaited remove that goes through the shared removal rule over TCP. */
const REMOVERS: Record<string, Remover> = {
  'FlowProducer job.remove()': (transport, id) =>
    createFlowJobObject(id, 'node', {}, 'mixed', {
      callbacks: { tcp: transport as unknown as TcpConnectionPool },
    }).remove(),
  'processor job.remove()': (transport, id) =>
    createRemoveHandler(false, transport as unknown as TcpConnection)(id),
  'queue.removeAsync()': (transport, id) =>
    removeAsync(
      { name: 'mixed', embedded: false, tcp: transport } as unknown as Parameters<
        typeof removeAsync
      >[0],
      id
    ),
};

let manager: QueueManager | null = null;

afterEach(() => {
  manager?.shutdown();
  manager = null;
});

test('the fixture is the reply this broker still sends for a missing job', () => {
  expect(LEGACY_REFUSAL).toBe(CANCEL_JOB_NOT_FOUND_ERROR);
});

for (const [label, remove] of Object.entries(REMOVERS)) {
  describe(`${label} against a 2.9.13 broker`, () => {
    for (const state of ['active', 'failed', 'completed']) {
      test(`a job in state ${state} is refused naming it and stays`, async () => {
        const broker = legacyBroker({ j1: state });

        await expect(remove(broker, 'j1')).rejects.toThrow(
          `Job j1 cannot be removed (current state: ${state})`
        );
        expect(broker.sent).toEqual(['Cancel', 'GetState']);
        expect(await broker.send({ cmd: 'GetState', id: 'j1' })).toMatchObject({ state });
      });
    }

    test('a missing job resolves after the state read', async () => {
      const broker = legacyBroker({});

      await expect(remove(broker, 'gone')).resolves.toBeUndefined();
      expect(broker.sent).toEqual(['Cancel', 'GetState']);
    });

    test('a waiting job is removed without a state read', async () => {
      const broker = legacyBroker({ w1: 'waiting' });

      await expect(remove(broker, 'w1')).resolves.toBeUndefined();
      expect(broker.sent).toEqual(['Cancel']);
      expect(await broker.send({ cmd: 'GetState', id: 'w1' })).toMatchObject({
        state: 'unknown',
      });
    });
  });

  describe(`${label} against this broker`, () => {
    async function jobsInEveryState(qm: QueueManager) {
      const completed = await qm.push('mixed', { data: {} });
      await qm.pull('mixed');
      await qm.ack(completed.id, { done: true });
      const failed = await qm.push('mixed', { data: {}, maxAttempts: 1 });
      await qm.pull('mixed');
      await qm.fail(failed.id, 'boom');
      const active = await qm.push('mixed', { data: {} });
      await qm.pull('mixed');
      return {
        completed: String(completed.id),
        failed: String(failed.id),
        active: String(active.id),
      };
    }

    test('active and failed reject with the reply, completed and missing resolve', async () => {
      manager = new QueueManager();
      const ids = await jobsInEveryState(manager);
      const broker = currentBroker(manager);

      for (const state of ['active', 'failed'] as const) {
        broker.sent.length = 0;
        await expect(remove(broker, ids[state])).rejects.toThrow(
          `Job cannot be cancelled: not in queue (current state: ${state})`
        );
        expect(broker.sent).toEqual(['Cancel']);
        expect(await manager.getJobState(ids[state] as never)).toBe(state);
      }

      broker.sent.length = 0;
      await expect(remove(broker, ids.completed)).resolves.toBeUndefined();
      expect(broker.sent).toEqual(['Cancel']);
      expect(await manager.getJobState(ids.completed as never)).toBe('unknown');

      broker.sent.length = 0;
      await expect(remove(broker, 'no-such-job')).resolves.toBeUndefined();
      expect(broker.sent).toEqual(['Cancel', 'GetState']);
    });
  });
}

describe('a state read that does not settle the legacy reply', () => {
  const refusingTransport = (getState: Record<string, unknown>): FakeTransport => {
    const sent: string[] = [];
    return {
      sent,
      send(command) {
        sent.push(String(command.cmd));
        if (command.cmd === 'Cancel') {
          return Promise.resolve({ ok: false, error: LEGACY_REFUSAL });
        }
        return Promise.resolve(getState);
      },
    };
  };

  test('a refused GetState rejects with its error', async () => {
    const transport = refusingTransport({ ok: false, error: 'Not authenticated' });
    await expect(REMOVERS['queue.removeAsync()'](transport, 'j')).rejects.toThrow(
      'Not authenticated'
    );
  });

  test('a GetState without a state rejects with the legacy refusal, as 2.9.13 did', async () => {
    const transport = refusingTransport({ ok: true, id: 'j' });
    await expect(REMOVERS['FlowProducer job.remove()'](transport, 'j')).rejects.toThrow(
      LEGACY_REFUSAL
    );
  });

  test('any other "not found" refusal still resolves without a state read', async () => {
    const sent: string[] = [];
    const transport: FakeTransport = {
      sent,
      send(command) {
        sent.push(String(command.cmd));
        return Promise.resolve({ ok: false, error: 'Job not found' });
      },
    };
    await expect(REMOVERS['processor job.remove()'](transport, 'j')).resolves.toBeUndefined();
    expect(sent).toEqual(['Cancel']);
  });
});
