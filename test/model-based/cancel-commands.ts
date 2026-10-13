import { expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { AsyncCommand, Arbitrary } from 'fast-check';
import fc from 'fast-check';
import { MODEL_JOB_IDS } from './model-ids';
import { QueueCommand } from './queue-command';
import type { ModelState, QueueModel, RealQueue } from './queue-model-harness';

const NOT_FOUND = 'Job not found or cannot be cancelled';

/**
 * The `pick`-th tracked job (wrapping) among those in `states`, or null when none is.
 * Picking among matching jobs, not by slot, lets generated histories reach these
 * commands as soon as one job is in a matching state.
 */
function pickJob(
  model: Readonly<QueueModel>,
  pick: number,
  states: readonly ModelState[]
): string | null {
  const ids = [...model.jobs].filter(([, job]) => states.includes(job.state)).map(([id]) => id);
  return ids.length === 0 ? null : ids[pick % ids.length]!;
}

/**
 * Cancel of a completed job (issue #155) removes the row and the result and keeps only
 * the payload-free completion proof, as removeOnComplete would have. The generation
 * stays in `terminalGenerations`, so it may never be delivered again, across restarts.
 */
class CancelCompletedCommand extends QueueCommand {
  constructor(private readonly pick: number) {
    super();
  }

  check(model: Readonly<QueueModel>): boolean {
    return pickJob(model, this.pick, ['completed']) !== null;
  }

  async run(model: QueueModel, real: RealQueue): Promise<void> {
    const id = pickJob(model, this.pick, ['completed'])!;
    const response = await real.send({ cmd: 'Cancel', id });
    expect(response.ok, `cancel completed ${id}`).toBe(true);
    const repeated = await real.send({ cmd: 'Cancel', id });
    expect(repeated, `repeated cancel of ${id}`).toMatchObject({ ok: false, error: NOT_FOUND });
    const state = await real.send({ cmd: 'GetState', id });
    expect(state.state, `state of removed ${id}`).toBe('unknown');
    const result = await real.send({ cmd: 'GetResult', id });
    expect(result.result ?? null, `result of removed ${id}`).toBeNull();

    const db = new Database(real.dbPath, { readonly: true });
    try {
      const count = (sql: string) => (db.query(sql).get(id) as { n: number }).n;
      expect(count('SELECT COUNT(*) AS n FROM jobs WHERE id = ?'), 'removed row').toBe(0);
      expect(count('SELECT COUNT(*) AS n FROM job_results WHERE job_id = ?'), 'result').toBe(0);
      expect(
        count('SELECT COUNT(*) AS n FROM dependency_completions WHERE job_id = ?'),
        'payload-free completion proof'
      ).toBe(1);
    } finally {
      db.close();
    }

    model.jobs.delete(id);
    model.removed++;
    real.tokens.delete(id);
    await this.verify(model, real);
  }

  toString(): string {
    return `cancelCompleted(#${this.pick})`;
  }
}

/** Cancel never removes an active or a failed job, and names the state that refused it. */
class CancelRefusedCommand extends QueueCommand {
  constructor(private readonly pick: number) {
    super();
  }

  check(model: Readonly<QueueModel>): boolean {
    return pickJob(model, this.pick, ['active', 'failed']) !== null;
  }

  async run(model: QueueModel, real: RealQueue): Promise<void> {
    const id = pickJob(model, this.pick, ['active', 'failed'])!;
    const state = model.jobs.get(id)!.state;
    const response = await real.send({ cmd: 'Cancel', id });
    expect(response, `cancel ${state} ${id}`).toMatchObject({
      ok: false,
      error: `Job cannot be cancelled (current state: ${state})`,
    });
    await this.verify(model, real);
  }

  toString(): string {
    return `cancelRefused(#${this.pick})`;
  }
}

export function cancelCommandArbitraries(): Arbitrary<AsyncCommand<QueueModel, RealQueue>>[] {
  const pick = fc.integer({ min: 0, max: MODEL_JOB_IDS.length - 1 });
  return [
    pick.map((value) => new CancelCompletedCommand(value)),
    pick.map((value) => new CancelRefusedCommand(value)),
  ];
}
