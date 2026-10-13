import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { RealQueue } from './model-based/queue-model-harness';

/**
 * Model campaign seed 278702072 (size `max`): addFlow -> pullBatch(2) -> ackFlowActive ->
 * pullBatch(2) -> crashRestart ended with the flow parent's SQLite row `delayed` where the
 * model expects `waiting`.
 *
 * Once its dependencies are resolved a parent is an ordinary job: stall recovery charges
 * the attempt and persists the backoff exactly as for a job that never had dependencies
 * (`updateForRetry`: `jobs.state='waiting'`, future `run_at`, API state `delayed`). Startup
 * recovery used to re-checkpoint every pending job with dependencies, even one whose
 * persisted ready state was already authoritative, rewriting its row to `delayed`.
 */
interface Row {
  attempts: number;
  run_at: number;
  stall_count: number;
  state: string;
  timeline: Uint8Array | null;
}

const CHILD = 'flow-stall-child';
const PARENT = 'flow-stall-parent';
const PLAIN = 'flow-stall-plain';

test('a stalled flow parent is recovered and persisted like a stalled plain job', async () => {
  const real = await RealQueue.create(`flow-parent-stall-recovery-${Date.now()}`);
  const push = (id: string, priority: number, extra: Record<string, unknown> = {}) =>
    real.send({
      backoff: 60000,
      cmd: 'PUSH',
      data: { generation: 1 },
      durable: true,
      jobId: id,
      priority,
      queue: real.queue,
      ...extra,
    });
  const rows = (): Map<string, Row> => {
    const db = new Database(real.dbPath, { readonly: true });
    try {
      const all = db
        .query<Row & { id: string }, [string]>(
          'SELECT id, state, attempts, stall_count, run_at, timeline FROM jobs WHERE queue = ?'
        )
        .all(real.queue);
      return new Map(all.map(({ id, ...row }) => [id, row]));
    } finally {
      db.close();
    }
  };

  try {
    await push(CHILD, 2);
    await push(PARENT, 1, { childrenIds: [CHILD], dependsOn: [CHILD] });
    await push(PLAIN, 1);

    const child = await real.send({
      cmd: 'PULL',
      lockTtl: 60000,
      owner: 'flow-stall-worker',
      queue: real.queue,
      timeout: 0,
    });
    expect((child.job as { id?: string })?.id).toBe(CHILD);
    expect((await real.send({ cmd: 'ACK', id: CHILD, token: child.token })).ok).toBe(true);
    expect((await real.send({ cmd: 'GetState', id: PARENT })).state).toBe('prioritized');
    expect(rows().get(PARENT)?.state).toBe('prioritized');

    const batch = await real.send({
      cmd: 'PULLB',
      count: 2,
      lockTtl: 60000,
      owner: 'flow-stall-worker',
      queue: real.queue,
      timeout: 0,
    });
    expect(new Set((batch.jobs as { id: string }[]).map((job) => job.id))).toEqual(
      new Set([PARENT, PLAIN])
    );

    await real.crashRestart();

    for (const id of [PARENT, PLAIN]) {
      expect((await real.send({ cmd: 'GetState', id })).state, `API state of ${id}`).toBe(
        'delayed'
      );
    }
    const recovered = rows();
    for (const id of [PARENT, PLAIN]) {
      const { attempts, stall_count, state } = recovered.get(id)!;
      expect({ attempts, stall_count, state }, `persisted retry of stalled ${id}`).toEqual({
        attempts: 1,
        stall_count: 1,
        state: 'waiting',
      });
    }

    // A restart with nothing to recover leaves every pending row untouched.
    await real.crashRestart();
    expect(rows()).toEqual(recovered);
    expect((await real.send({ cmd: 'GetState', id: PARENT })).state).toBe('delayed');
  } finally {
    await real.dispose();
  }
}, 30000);
