import { describe, expect, test } from 'bun:test';
import { startMcp, type McpMode } from './mcp-harness';

for (const mode of ['embedded', 'tcp'] satisfies McpMode[]) {
  describe(`Agent inspection (${mode})`, () => {
    test('observes completed jobs with empty results without waiting', async () => {
      const m = await startMcp({ mode });
      try {
        const { jobId } = await m.backend.addJob('observe', 'task', {});
        await m.backend.pullJob('observe');
        await m.backend.ackJob(jobId, null);
        const r = await m.call('bunqueue_observe_job', { jobId, timeoutMs: 1000 });
        expect(r.isError).toBe(false);
        expect(r.json.state).toBe('completed');
        expect(r.json.terminal).toBe(true);
        expect(r.json.result).toBeNull();
        expect(r.json.timedOut).toBe(false);
        expect(r.json.nextPollMs).toBeNull();
      } finally {
        await m.close();
      }
    });

    test('distinguishes failure from unknown or removed jobs', async () => {
      const m = await startMcp({ mode });
      try {
        const { jobId } = await m.backend.addJob('failed-observe', 'task', {});
        await m.backend.pullJob('failed-observe');
        await m.backend.failJob(jobId, 'test failure', { unrecoverable: true });
        const failed = await m.call('bunqueue_observe_job', { jobId });
        expect(failed.isError).toBe(false);
        expect(failed.json.state).toBe('failed');
        expect(failed.json.terminal).toBe(true);
        expect(failed.json.failure).toBeDefined();
        const absent = await m.call('bunqueue_observe_job', { jobId: 'does-not-exist' });
        expect(absent.json.state).toBe('unknown');
        expect(absent.json.terminal).toBe(false);
        expect(absent.json.result).toBeUndefined();
      } finally {
        await m.close();
      }
    });

    test('times out delayed jobs with progress and preserves queue counts', async () => {
      const m = await startMcp({ mode });
      try {
        const { jobId } = await m.backend.addJob('delay-observe', 'task', {}, { delay: 60000 });
        const r = await m.call('bunqueue_observe_job', {
          jobId,
          timeoutMs: 50,
          pollIntervalMs: 25,
        });
        expect(r.isError).toBe(false);
        expect(r.json.state).toBe('delayed');
        expect(r.json.terminal).toBe(false);
        expect(r.json.timedOut).toBe(true);
        expect(r.json.progress).toMatchObject({ progress: 0 });
        expect(r.json.nextPollMs).toBe(25);
        expect((await m.backend.getJobCounts('delay-observe')).delayed).toBe(1);
      } finally {
        await m.close();
      }
    });

    test('request cancellation stops observation promptly', async () => {
      const m = await startMcp({ mode });
      try {
        const { jobId } = await m.backend.addJob('abort-observe', 'task', {});
        const getState = m.backend.getJobState.bind(m.backend);
        let reads = 0;
        m.backend.getJobState = (id) => {
          reads++;
          return getState(id);
        };
        const abort = new AbortController();
        const pending = m.client.callTool(
          {
            name: 'bunqueue_observe_job',
            arguments: { jobId, timeoutMs: 30000, pollIntervalMs: 25 },
          },
          undefined,
          { signal: abort.signal }
        );
        await Bun.sleep(30);
        abort.abort();
        await expect(pending).rejects.toThrow();
        const before = reads;
        await Bun.sleep(100);
        expect(reads).toBeLessThanOrEqual(before + 1);
        expect((await m.backend.getJobCounts('abort-observe')).waiting).toBe(1);
      } finally {
        await m.close();
      }
    });

    test('timeout also bounds a slow backend read without mutating the job', async () => {
      const m = await startMcp({ mode });
      let releaseRead: (() => void) | undefined;
      let outstanding: Promise<string> | undefined;
      try {
        const { jobId } = await m.backend.addJob('slow-observe', 'task', {});
        const read = m.backend.getJobState.bind(m.backend);
        const blocked = new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
        let readFinished = false;
        m.backend.getJobState = async (id) => {
          outstanding = blocked.then(() => read(id));
          const state = await outstanding;
          readFinished = true;
          return state;
        };
        const r = await Promise.race([
          m.call('bunqueue_observe_job', { jobId, timeoutMs: 25 }),
          Bun.sleep(1000).then(() => null),
        ]);
        expect(r).not.toBeNull();
        expect(r?.json.timedOut).toBe(true);
        expect(r?.json.terminal).toBe(false);
        expect(readFinished).toBe(false);
        expect((await m.backend.getJobCounts('slow-observe')).waiting).toBe(1);
      } finally {
        releaseRead?.();
        await outstanding;
        await m.close();
      }
    });

    test('pages summaries without leaking payload or options and probes one extra row', async () => {
      const m = await startMcp({ mode });
      try {
        for (let i = 0; i < 3; i++) {
          await m.backend.addJob(
            'page',
            'task',
            { secret: 'payload-secret' },
            { tags: ['tag-secret'] }
          );
        }
        const first = await m.call('bunqueue_list_jobs_page', { queue: 'page', limit: 2 });
        expect(first.isError).toBe(false);
        expect(first.json.count).toBe(2);
        expect(first.json.hasMore).toBe(true);
        expect(first.json.nextOffset).toBe(2);
        expect(first.text).not.toContain('payload-secret');
        expect(first.text).not.toContain('tag-secret');
        const last = await m.call('bunqueue_list_jobs_page', {
          queue: 'page',
          offset: 2,
          limit: 2,
        });
        expect(last.json.count).toBe(1);
        expect(last.json.hasMore).toBe(false);
        expect(last.json.nextOffset).toBeNull();
      } finally {
        await m.close();
      }
    });

    test('bounds oversized unicode payloads and rejects unsafe page limits', async () => {
      const m = await startMcp({ mode });
      try {
        await m.backend.addJob('large-page', 'task', { value: '💡'.repeat(100000) });
        const r = await m.call('bunqueue_list_jobs_page', {
          queue: 'large-page',
          includeData: true,
        });
        expect(r.isError).toBe(false);
        expect(r.json.truncated).toBe(true);
        expect(Buffer.byteLength(r.text)).toBeLessThan(65536);
        expect((r.json.jobs as Array<Record<string, unknown>>)[0].dataTruncated).toBe(true);
        expect(
          (await m.call('bunqueue_list_jobs_page', { queue: 'large-page', limit: 101 })).isError
        ).toBe(true);
      } finally {
        await m.close();
      }
    });

    test('diagnosis reports complete accounting and observed blockers without guessing workers', async () => {
      const m = await startMcp({ mode });
      try {
        await m.backend.addJob(
          'diagnose',
          'task',
          { secret: 'diagnostic-secret' },
          { priority: 7 }
        );
        await m.backend.pauseQueue('diagnose');
        const r = await m.call('bunqueue_diagnose_queue', { queue: 'diagnose' });
        expect(r.isError).toBe(false);
        expect(r.json.total).toBe(1);
        expect(r.json.counts).toMatchObject({ paused: 1, prioritized: 0 });
        expect(r.json.limits).toMatchObject({ paused: true });
        expect(r.json.blockers).toContain('paused');
        expect(r.json.observedAt).toBeString();
        expect(r.text).not.toContain('diagnostic-secret');
        expect(r.text).not.toContain('no_workers');
      } finally {
        await m.close();
      }
    });
  });
}
