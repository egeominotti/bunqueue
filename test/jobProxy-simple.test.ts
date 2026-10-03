/**
 * Tests for src/client/queue/jobProxy.ts: createSimpleJob (embedded/read-only mode)
 * and edge cases shared with createJobProxy (TCP mode, test/jobProxy.test.ts).
 */
import { describe, test, expect } from 'bun:test';
import { createJobProxy, createSimpleJob } from '../src/client/queue/jobProxy';
import { createMockCtx, createSimpleCtx } from './support/job-proxy-doubles';

describe('createSimpleJob', () => {
  test('sets core properties with explicit timestamp and defaults', () => {
    const ctx = createSimpleCtx({ queueName: 'emails' });
    const job = createSimpleJob('s1', 'send', { to: 'a@b.com' }, 1700000000000, ctx);
    expect(job.id).toBe('s1');
    expect(job.name).toBe('send');
    expect(job.data).toEqual({ to: 'a@b.com' });
    expect(job.queueName).toBe('emails');
    expect(job.timestamp).toBe(1700000000000);
    expect(job.attemptsMade).toBe(0);
    expect(job.progress).toBe(0);
    expect(job.delay).toBe(0);
    expect(job.stalledCounter).toBe(0);
    expect(job.priority).toBe(0);
    expect(job.stacktrace).toBeNull();
    expect(job.opts).toEqual({});
    expect(job.attemptsStarted).toBe(0);
  });

  test('all mutation methods are no-ops', async () => {
    const ctx = createSimpleCtx();
    const job = createSimpleJob('s1', 'test', {}, 0, ctx);
    await expect(job.updateProgress(50)).resolves.toBeUndefined();
    await expect(job.log('hello')).resolves.toBeUndefined();
    await expect(job.updateData({ x: 1 })).resolves.toBeUndefined();
    await expect(job.promote()).resolves.toBeUndefined();
    await expect(job.changeDelay(5000)).resolves.toBeUndefined();
    await expect(job.changePriority({ priority: 5 })).resolves.toBeUndefined();
    expect(await job.extendLock('tok', 30000)).toBe(0);
    await expect(job.clearLogs()).resolves.toBeUndefined();
  });

  test('all move methods behave correctly without execution context', async () => {
    const ctx = createSimpleCtx();
    const job = createSimpleJob('s1', 'test', {}, 0, ctx);
    expect(await job.moveToCompleted({ ok: true })).toBeNull();
    await expect(job.moveToFailed(new Error('x'))).resolves.toBeUndefined();
    expect(await job.moveToWait()).toBe(false);
    await expect(job.moveToDelayed(Date.now())).resolves.toBeUndefined();
    expect(await job.moveToWaitingChildren()).toBe(false);
    await expect(job.waitUntilFinished(null)).rejects.toThrow(/waitUntilFinished: no connection/);
  });

  test('state check methods delegate to context', async () => {
    const ctx = createSimpleCtx({ getJobState: async () => 'completed' });
    const job = createSimpleJob('s1', 'test', {}, 0, ctx);
    expect(await job.getState()).toBe('completed');
    expect(await job.isCompleted()).toBe(true);
    expect(await job.isWaiting()).toBe(false);
    expect(await job.isActive()).toBe(false);
    expect(await job.isDelayed()).toBe(false);
    expect(await job.isFailed()).toBe(false);
    expect(await job.isWaitingChildren()).toBe(false);
  });

  test('context delegation: remove, retry, getChildrenValues', async () => {
    let removedId = '';
    let retriedId = '';
    const ctx = createSimpleCtx({
      removeAsync: async (id: string) => {
        removedId = id;
      },
      retryJob: async (id: string) => {
        retriedId = id;
      },
      getChildrenValues: async () => ({ 'q:c1': 'done' }),
    });
    const job = createSimpleJob('s1', 'test', {}, 0, ctx);
    await job.remove();
    expect(removedId).toEqual('s1');
    await job.retry();
    expect(retriedId).toEqual('s1');
    expect(await job.getChildrenValues()).toEqual({ 'q:c1': 'done' });
  });

  test('serialization: toJSON and asJSON', () => {
    const ctx = createSimpleCtx({ queueName: 'billing' });
    const job = createSimpleJob('s1', 'invoice', { amt: 100 }, 1700000000000, ctx);
    const json = job.toJSON();
    expect(json.id).toBe('s1');
    expect(json.name).toBe('invoice');
    expect(json.data).toEqual({ amt: 100 });
    expect(json.timestamp).toBe(1700000000000);
    expect(json.queueQualifiedName).toBe('bull:billing');
    const raw = job.asJSON();
    expect(raw.data).toBe(JSON.stringify({ amt: 100 }));
    expect(raw.timestamp).toBe('1700000000000');
    expect(raw.opts).toBe('{}');
    expect(raw.progress).toBe('0');
    expect(raw.delay).toBe('0');
    expect(raw.attemptsMade).toBe('0');
    expect(raw.stacktrace).toBeNull();
  });

  test('detached dependency, child, discard, and dedup methods are safe', async () => {
    const ctx = createSimpleCtx();
    const job = createSimpleJob('s1', 'test', {}, 0, ctx);
    expect(() => job.discard()).not.toThrow();
    expect(await job.getDependencies()).toEqual({ processed: {}, unprocessed: [] });
    expect(await job.getDependenciesCount()).toEqual({ processed: 0, unprocessed: 0 });
    expect(await job.getFailedChildrenValues()).toEqual({});
    expect(await job.removeChildDependency()).toBe(false);
    expect(await job.removeDeduplicationKey()).toBe(false);
    await expect(job.removeUnprocessedChildren()).resolves.toBeUndefined();
  });
});

describe('edge cases', () => {
  test('query proxies reflect lifecycle metadata in properties and serialization', () => {
    const { ctx } = createMockCtx({ queueName: 'metadata' });
    const meta = {
      attemptsMade: 2,
      attemptsStarted: 2,
      progress: 45,
      stalledCounter: 1,
      processedOn: 1_700_000_000_100,
      finishedOn: 1_700_000_000_200,
    };
    const jobs = [
      createJobProxy('tcp-meta', 'task', {}, ctx, meta),
      createSimpleJob('simple-meta', 'task', {}, 1_700_000_000_000, {
        ...createSimpleCtx({ queueName: 'metadata' }),
        meta,
      }),
    ];

    for (const job of jobs) {
      expect(job.attemptsMade).toBe(2);
      expect(job.attemptsStarted).toBe(2);
      expect(job.progress).toBe(45);
      expect(job.stalledCounter).toBe(1);
      expect(job.processedOn).toBe(1_700_000_000_100);
      expect(job.finishedOn).toBe(1_700_000_000_200);
      expect(job.toJSON()).toMatchObject({
        attemptsMade: 2,
        progress: 45,
        processedOn: 1_700_000_000_100,
        finishedOn: 1_700_000_000_200,
      });
      expect(job.asJSON()).toMatchObject({
        attemptsMade: '2',
        progress: '45',
        processedOn: '1700000000100',
        finishedOn: '1700000000200',
      });
    }
  });

  test('null data, undefined fields, nested data, empty id, zero timestamp', () => {
    const { ctx } = createMockCtx();
    const nullJob = createJobProxy('e1', 'test', null, ctx);
    expect(nullJob.data).toBeNull();
    expect(nullJob.toJSON().data).toBeNull();
    expect(nullJob.asJSON().data).toBe('null');

    const sCtx = createSimpleCtx();
    expect(createSimpleJob('e2', 'test', { a: undefined, b: 1 }, 0, sCtx).data).toEqual({
      a: undefined,
      b: 1,
    });

    const data = { nested: { deep: { array: [1, 2, 3] } } };
    expect(JSON.parse(createJobProxy('e3', 'test', data, ctx).asJSON().data)).toEqual(data);

    expect(createJobProxy('', 'test', {}, ctx).toJSON().id).toBe('');
    const sJob = createSimpleJob('e4', 'test', {}, 0, sCtx);
    expect(sJob.timestamp).toBe(0);
    expect(sJob.asJSON().timestamp).toBe('0');
  });
});
