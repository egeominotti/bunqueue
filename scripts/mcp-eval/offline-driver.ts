import type { TaskDriver, ToolReply } from './task-types';

function requireSuccess(reply: ToolReply) {
  if (reply.outcome !== 'success') throw new Error(`Unexpected tool outcome: ${reply.outcome}`);
  return reply.data;
}

/** Hand-written functional scripts, not an LLM or an agent-performance measurement. */
export const offlineDriver: TaskDriver = {
  name: 'offline-deterministic',
  async run({ scenario, queue, jobIds, call, listTools }) {
    await listTools();
    requireSuccess(
      await call('bunqueue_enable_toolsets', {
        toolsets: ['jobs', 'processing', 'queues', 'monitoring'],
      })
    );
    const jobId = jobIds[0];
    if (scenario === 'complete') {
      const pulled = requireSuccess(await call('bunqueue_pull_job', { queue }));
      if ((pulled.job as { id?: string } | null)?.id !== jobId)
        throw new Error('Wrong task pulled');
      requireSuccess(await call('bunqueue_ack_job', { jobId, result: null }));
      return {
        evidence: requireSuccess(await call('bunqueue_observe_job', { jobId, timeoutMs: 0 })),
      };
    }
    if (scenario === 'terminal') {
      const failed = requireSuccess(await call('bunqueue_observe_job', { jobId, timeoutMs: 0 }));
      const unknown = requireSuccess(
        await call('bunqueue_observe_job', { jobId: `${queue}-missing`, timeoutMs: 0 })
      );
      return { evidence: { failed, unknown } };
    }
    if (scenario === 'pages') {
      const jobs: unknown[] = [];
      let offset = 0;
      for (let page = 0; page < 10; page++) {
        const data = requireSuccess(
          await call('bunqueue_list_jobs_page', { queue, state: 'waiting', limit: 2, offset })
        );
        jobs.push(...(data.jobs as unknown[]));
        if (data.hasMore === false) {
          const rejected = await call('bunqueue_list_jobs_page', { queue, limit: 101 });
          return { evidence: { jobs, rejected } };
        }
        if (typeof data.nextOffset !== 'number' || data.nextOffset <= offset)
          throw new Error('Non-progressing page');
        offset = data.nextOffset;
      }
      throw new Error('Paging exceeded fixture bound');
    }
    if (scenario === 'diagnose') {
      return { evidence: requireSuccess(await call('bunqueue_diagnose_queue', { queue })) };
    }
    return { evidence: { preview: await call('bunqueue_obliterate_queue', { queue }) } };
  },
};
