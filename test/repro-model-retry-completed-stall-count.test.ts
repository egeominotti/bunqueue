import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { RealQueue } from './model-based/queue-model-harness';

/**
 * Terminal-lifecycle model campaign seed 1047906753, path 29 (default settings), minimized:
 * push -> pull -> crashRestart -> promote -> pull -> ack -> retryCompleted ended with
 * `stallCount` 1 where the model expects 0.
 *
 * A retry starts a fresh execution with a fresh attempt budget. A DLQ retry already resets
 * both budgets (`attempts` and `stallCount`), and so does the PostgreSQL engine's retry of
 * a completed job (`retryPostgresTerminalJob`). The SQLite/in-memory completed retry reset
 * `attempts` but carried the old generation's stalls, so a job that stalled before it
 * completed reached `maxStalls` early in its next execution.
 */
const COMPLETED = 'stall-retry-completed';
const FAILED = 'stall-retry-failed';

test('a completed retry resets the stall budget like a DLQ retry', async () => {
  const real = await RealQueue.create(`retry-completed-stall-${Date.now()}`);
  const pull = async (expected: string): Promise<string> => {
    const response = await real.send({
      cmd: 'PULL',
      lockTtl: 60000,
      owner: 'stall-retry-worker',
      queue: real.queue,
      timeout: 0,
    });
    expect((response.job as { id?: string })?.id).toBe(expected);
    return String(response.token);
  };
  const counters = async (id: string) => {
    const { job } = (await real.send({ cmd: 'GetJob', id })) as {
      job: { attempts: number; stallCount: number };
    };
    const db = new Database(real.dbPath, { readonly: true });
    try {
      const row = db
        .query<{ attempts: number; stall_count: number }, [string]>(
          'SELECT attempts, stall_count FROM jobs WHERE id = ?'
        )
        .get(id);
      return { api: [job.attempts, job.stallCount], sqlite: [row?.attempts, row?.stall_count] };
    } finally {
      db.close();
    }
  };

  try {
    for (const id of [COMPLETED, FAILED]) {
      await real.send({
        backoff: 60000,
        cmd: 'PUSH',
        data: {},
        durable: true,
        jobId: id,
        maxAttempts: 3,
        queue: real.queue,
      });
      await pull(id);
      await real.crashRestart();
      expect((await real.send({ cmd: 'GetState', id })).state).toBe('delayed');
      expect((await real.send({ cmd: 'Promote', id })).ok).toBe(true);
      const token = await pull(id);
      const outcome =
        id === COMPLETED
          ? await real.send({ cmd: 'ACK', id, result: {}, token })
          : await real.send({ cmd: 'FAIL', error: 'terminal', id, token, unrecoverable: true });
      expect(outcome.ok).toBe(true);
    }

    expect((await real.send({ cmd: 'RetryDlq', jobId: FAILED, queue: real.queue })).count).toBe(1);
    expect(
      (await real.send({ cmd: 'RetryCompleted', id: COMPLETED, queue: real.queue })).count
    ).toBe(1);

    expect(await counters(FAILED), 'DLQ retry').toEqual({ api: [0, 0], sqlite: [0, 0] });
    expect(await counters(COMPLETED), 'completed retry').toEqual({ api: [0, 0], sqlite: [0, 0] });

    await real.crashRestart();
    expect(await counters(COMPLETED), 'completed retry after restart').toEqual({
      api: [0, 0],
      sqlite: [0, 0],
    });
  } finally {
    await real.dispose();
  }
}, 30000);
