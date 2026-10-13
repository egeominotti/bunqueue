/**
 * Issue #155 B, wire and client level: what `Cancel` answers and how `remove()` reports it.
 *
 * Before the fix the broker answered the same ambiguous `Job not found or cannot be
 * cancelled` for a completed, an active, a failed and a missing job, and every awaited
 * `remove()` ignored it. The broker now removes a completed job, keeps the legacy text
 * only for a missing one and names the state for any other refusal; clients reject on a
 * refusal and still resolve for a missing job (idempotent cleanup, as BullMQ).
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { assertCancelReply } from '../src/client/jobRemoval';
import type { Job } from '../src/client';
import { handleCancel } from '../src/infrastructure/server/handlers/management';
import { routeJobRoutes } from '../src/infrastructure/server/httpRouteJobs';
import type { HandlerContext } from '../src/infrastructure/server/types';
import { CoreE2eHarness } from './core-e2e/support/harness';
import { createFailedJob } from './core-e2e/support/job-fixtures';

setDefaultTimeout(30_000);

const NOT_FOUND = 'Job not found or cannot be cancelled';

let manager: QueueManager | null = null;
let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  manager?.shutdown();
  manager = null;
  await harness?.close();
  harness = null;
});

function context(qm: QueueManager): HandlerContext {
  return { queueManager: qm, authTokens: new Set(), authenticated: false, clientId: 'i155' };
}

/** One job in each state Cancel answers for. */
async function jobsInEveryState(qm: QueueManager) {
  const completed = await qm.push('replies', { data: {} });
  await qm.pull('replies');
  await qm.ack(completed.id, { done: true });
  const failed = await qm.push('replies', { data: {}, maxAttempts: 1 });
  await qm.pull('replies');
  await qm.fail(failed.id, 'boom');
  const active = await qm.push('replies', { data: {} });
  await qm.pull('replies');
  return { completed: completed.id, active: active.id, failed: failed.id };
}

describe('server Cancel replies', () => {
  test('completed is removed; active, failed and missing name what refused it', async () => {
    manager = new QueueManager();
    const ctx = context(manager);
    const ids = await jobsInEveryState(manager);
    expect(await manager.getJobState(ids.failed)).toBe('failed');

    expect(await handleCancel({ cmd: 'Cancel', id: ids.completed }, ctx, 'r1')).toEqual({
      ok: true,
      reqId: 'r1',
    });
    expect(await manager.getJobState(ids.completed)).toBe('unknown');
    expect(await handleCancel({ cmd: 'Cancel', id: ids.active }, ctx)).toMatchObject({
      ok: false,
      error: 'Job cannot be cancelled (current state: active)',
    });
    expect(await handleCancel({ cmd: 'Cancel', id: ids.failed }, ctx)).toMatchObject({
      ok: false,
      error: 'Job cannot be cancelled (current state: failed)',
    });
    expect(await handleCancel({ cmd: 'Cancel', id: 'no-such-job' }, ctx)).toMatchObject({
      ok: false,
      error: NOT_FOUND,
    });
    expect(await handleCancel({ cmd: 'Cancel', id: ids.completed }, ctx)).toMatchObject({
      ok: false,
      error: NOT_FOUND,
    });
    expect(await manager.getJobState(ids.active)).toBe('active');
    expect(await manager.getJobState(ids.failed)).toBe('failed');
  });

  test('HTTP DELETE /jobs/:id follows the same rule', async () => {
    manager = new QueueManager();
    const ctx = context(manager);
    const ids = await jobsInEveryState(manager);
    const remove = async (id: string) => {
      const path = `/jobs/${id}`;
      const request = new Request(`http://localhost${path}`, { method: 'DELETE' });
      const response = await routeJobRoutes(request, path, 'DELETE', ctx, new Set());
      return { status: response!.status, body: await response!.json() };
    };

    expect(await remove(ids.completed)).toEqual({ status: 200, body: { ok: true } });
    expect(await remove(ids.active)).toMatchObject({
      status: 200,
      body: { ok: false, error: 'Job cannot be cancelled (current state: active)' },
    });
    expect(await remove('no-such-job')).toMatchObject({
      status: 200,
      body: { ok: false, error: NOT_FOUND },
    });
  });
});

describe('TCP Cancel reply mapping', () => {
  test('ok and "not found" resolve, any other rejection throws the broker message', () => {
    expect(() => assertCancelReply({ ok: true })).not.toThrow();
    expect(() => assertCancelReply({ ok: false, error: NOT_FOUND })).not.toThrow();
    expect(() =>
      assertCancelReply({ ok: false, error: 'Job cannot be cancelled (current state: active)' })
    ).toThrow('Job cannot be cancelled (current state: active)');
    expect(() => assertCancelReply({ ok: false, error: 'Not authenticated' })).toThrow(
      'Not authenticated'
    );
    expect(() => assertCancelReply({ ok: false })).toThrow('Cancel failed');
  });
});

for (const mode of ['embedded', 'tcp'] as const) {
  describe(`remove() refusals [${mode}]`, () => {
    test('removeAsync on a failed job rejects and keeps it failed', async () => {
      harness = await CoreE2eHarness.start(mode, 'i155-remove-failed');
      const queue = harness.queue<{ n: number }>('remove-failed');
      const failed = await createFailedJob(harness, queue, { n: 1 });

      await expect(queue.removeAsync(failed.id)).rejects.toThrow(/failed/);
      expect(await queue.getJobState(failed.id)).toBe('failed');
    });

    test('job.remove() inside its own processor rejects; the job still completes', async () => {
      harness = await CoreE2eHarness.start(mode, 'i155-remove-processor');
      const queue = harness.queue<{ n: number }>('remove-processor');
      const added = await queue.add('own', { n: 1 }, { durable: true });
      const removal = Promise.withResolvers<string>();
      harness.worker(queue.name, async (job: Job<{ n: number }>) => {
        try {
          await job.remove();
          removal.resolve('resolved');
        } catch (error) {
          removal.resolve((error as Error).message);
        }
        return { done: true };
      });

      expect(await removal.promise).toMatch(/active/);
      for (let i = 0; i < 400 && (await queue.getJobState(added.id)) !== 'completed'; i++) {
        await Bun.sleep(5);
      }
      expect(await queue.getJobState(added.id)).toBe('completed');
    });
  });
}
