/**
 * Tests for src/client/queue/jobProxy.ts: createJobProxy (TCP mode).
 * createSimpleJob (embedded/read-only mode) and edge cases: test/jobProxy-simple.test.ts.
 */
import { describe, test, expect } from 'bun:test';
import { createJobProxy } from '../src/client/queue/jobProxy';
import type { JobStateType } from '../src/client/types';
import { createMockCtx, createMockTcp } from './support/job-proxy-doubles';

describe('createJobProxy', () => {
  test('sets core properties and BullMQ defaults', () => {
    const before = Date.now();
    const { ctx } = createMockCtx({ queueName: 'emails' });
    const job = createJobProxy('job-1', 'send-email', { to: 'a@b.com' }, ctx);
    expect(job.id).toBe('job-1');
    expect(job.name).toBe('send-email');
    expect(job.data).toEqual({ to: 'a@b.com' });
    expect(job.queueName).toBe('emails');
    expect(job.timestamp).toBeGreaterThanOrEqual(before);
    expect(job.attemptsMade).toBe(0);
    expect(job.progress).toBe(0);
    expect(job.delay).toBe(0);
    expect(job.processedOn).toBeUndefined();
    expect(job.finishedOn).toBeUndefined();
    expect(job.stacktrace).toBeNull();
    expect(job.stalledCounter).toBe(0);
    expect(job.priority).toBe(0);
    expect(job.parentKey).toBeUndefined();
    expect(job.opts).toEqual({});
    expect(job.token).toBeUndefined();
    expect(job.processedBy).toBeUndefined();
    expect(job.deduplicationId).toBeUndefined();
    expect(job.repeatJobKey).toBeUndefined();
    expect(job.attemptsStarted).toBe(0);
  });

  test('TCP mutation methods send correct commands', async () => {
    const { ctx, calls } = createMockCtx();
    const job = createJobProxy('j1', 'task', { old: true }, ctx);
    await job.updateProgress(75, 'msg');
    expect(calls[0]).toEqual({ cmd: 'Progress', id: 'j1', progress: 75, message: 'msg' });
    await job.log('step 1');
    expect(calls[1]).toEqual({ cmd: 'AddLog', id: 'j1', message: 'step 1' });
    await job.updateData({ updated: true });
    expect(calls[2]).toEqual({ cmd: 'Update', id: 'j1', data: { updated: true } });
    await job.promote();
    expect(calls[3]).toEqual({ cmd: 'Promote', id: 'j1' });
    await job.changeDelay(5000);
    expect(calls[4]).toEqual({ cmd: 'ChangeDelay', id: 'j1', delay: 5000 });
    await job.changePriority({ priority: 10 });
    expect(calls[5]).toEqual({ cmd: 'ChangePriority', id: 'j1', priority: 10 });
    await job.clearLogs();
    expect(calls[6]).toEqual({ cmd: 'ClearLogs', id: 'j1' });
  });

  test('extendLock returns duration on success, 0 on failure', async () => {
    const { ctx } = createMockCtx();
    expect(await createJobProxy('j1', 'task', {}, ctx).extendLock('tok', 30000)).toBe(30000);
    const { tcp: failTcp } = createMockTcp();
    failTcp.send = async () => ({ ok: false });
    const { ctx: failCtx } = createMockCtx({ tcp: failTcp });
    expect(await createJobProxy('j2', 'task', {}, failCtx).extendLock('tok', 30000)).toBe(0);
  });

  test('move methods send correct commands and return expected values', async () => {
    const { ctx, calls } = createMockCtx();
    const job = createJobProxy('j1', 'task', {}, ctx);
    expect(await job.moveToCompleted({ success: true })).toBeNull();
    expect(calls[0]).toEqual({ cmd: 'ACK', id: 'j1', result: { success: true } });
    await job.moveToFailed(new Error('boom'));
    // FAIL now carries the stacktrace (#74/#111-class fix): assert the core
    // fields plus that the stack is forwarded, rather than an exact-shape match.
    expect(calls[1].cmd).toBe('FAIL');
    expect(calls[1].id).toBe('j1');
    expect(calls[1].error).toBe('boom');
    expect(Array.isArray(calls[1].stack)).toBe(true);
    expect(await job.moveToWait()).toBe(true);
    const ts = Date.now() + 5000;
    await job.moveToDelayed(ts);
    // BullMQ API passes absolute timestamp; our TCP protocol expects relative delay
    expect(calls[3].cmd).toBe('MoveToDelayed');
    expect(calls[3].id).toBe('j1');
    expect(calls[3].delay).toBeGreaterThan(4000);
    expect(calls[3].delay).toBeLessThanOrEqual(5000);

    expect(await job.moveToWaitingChildren()).toBe(true);
    expect(calls[4]).toEqual({ cmd: 'MoveToWaitingChildren', id: 'j1' });
    // waitUntilFinished throws on timeout when mock response has no completed flag.
    // The job never finishes for this mock, so the wait holds until its TTL.
    await expect(job.waitUntilFinished(null, 100)).rejects.toThrow(
      /waitUntilFinished timed out after 100ms/
    );
  });

  test('state check methods delegate correctly for all states', async () => {
    for (const state of ['waiting', 'active', 'delayed', 'completed', 'failed'] as JobStateType[]) {
      const { ctx } = createMockCtx({ getJobState: async () => state });
      const job = createJobProxy('j1', 'task', {}, ctx);
      expect(await job.getState()).toBe(state);
      expect(await job.isWaiting()).toBe(state === 'waiting');
      expect(await job.isActive()).toBe(state === 'active');
      expect(await job.isDelayed()).toBe(state === 'delayed');
      expect(await job.isCompleted()).toBe(state === 'completed');
      expect(await job.isFailed()).toBe(state === 'failed');
    }
    const { ctx } = createMockCtx();
    expect(await createJobProxy('j1', 'task', {}, ctx).isWaitingChildren()).toBe(false);
  });

  test('context delegation: remove, retry, getChildrenValues', async () => {
    let removedId: string | null = null;
    let retriedId: string | null = null;
    const { ctx } = createMockCtx({
      removeAsync: async (id: string) => {
        removedId = id;
      },
      retryJob: async (id: string) => {
        retriedId = id;
      },
      getChildrenValues: async () => ({ 'q:c1': 42 }),
    });
    const job = createJobProxy('j1', 'task', {}, ctx);
    await job.remove();
    expect(removedId).toEqual('j1');
    await job.retry();
    expect(retriedId).toEqual('j1');
    expect(await job.getChildrenValues()).toEqual({ 'q:c1': 42 });
  });

  test('serialization: toJSON and asJSON', () => {
    const { ctx } = createMockCtx({ queueName: 'my-queue' });
    const job = createJobProxy('j1', 'send', { to: 'a@b.com' }, ctx);
    const json = job.toJSON();
    expect(json.id).toBe('j1');
    expect(json.name).toBe('send');
    expect(json.data).toEqual({ to: 'a@b.com' });
    expect(json.opts).toEqual({});
    expect(json.progress).toBe(0);
    expect(json.delay).toBe(0);
    expect(json.attemptsMade).toBe(0);
    expect(json.stacktrace).toBeNull();
    expect(json.queueQualifiedName).toBe('bull:my-queue');
    const raw = job.asJSON();
    expect(raw.id).toBe('j1');
    expect(raw.data).toBe(JSON.stringify({ to: 'a@b.com' }));
    expect(raw.opts).toBe('{}');
    expect(raw.progress).toBe('0');
    expect(raw.delay).toBe('0');
    expect(raw.attemptsMade).toBe('0');
    expect(raw.stacktrace).toBeNull();
    expect(typeof raw.timestamp).toBe('string');
  });

  test('dependency, child, discard, and dedup methods dispatch', async () => {
    const { ctx } = createMockCtx();
    const job = createJobProxy('j1', 'task', {}, ctx);
    expect(await job.getDependencies()).toEqual({ processed: {}, unprocessed: [] });
    expect(await job.getDependenciesCount()).toEqual({ processed: 0, unprocessed: 0 });
    expect(() => job.discard()).not.toThrow();
    expect(await job.getFailedChildrenValues()).toEqual({});
    expect(await job.getIgnoredChildrenFailures()).toEqual({});
    expect(await job.removeChildDependency()).toBe(false);
    expect(await job.removeDeduplicationKey()).toBe(true);
    await expect(job.removeUnprocessedChildren()).resolves.toBeUndefined();
  });
});
