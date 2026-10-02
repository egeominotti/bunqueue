/**
 * Job options in the `opts` of the MCP flow tools (bunqueue_add_flow, bunqueue_add_flow_chain,
 * bunqueue_add_flow_bulk_then), embedded and over TCP. Over TCP the flow must be committed
 * on the broker: the TCP backend's FlowProducer used to inherit BUNQUEUE_EMBEDDED=1 from the
 * environment (set by the test preload) and silently commit flows to an in-process engine.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { jobId as toJobId } from '../src/domain/types/job';
import { startMcp, type McpMode } from './mcp-harness';

type Mcp = Awaited<ReturnType<typeof startMcp>>;
const MODES: McpMode[] = ['embedded', 'tcp'];
const open: Mcp[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});
async function mcp(mode: McpMode) {
  const m = await startMcp({ mode });
  open.push(m);
  return m;
}

for (const mode of MODES) {
  describe(`[${mode}] flow job options`, () => {
    test('flow jobs take the flow options; a flow jobId must be new', async () => {
      const m = await mcp(mode);
      const opts = { jobId: 'step-1', attempts: 2, backoff: 300, timeout: 1000, lifo: true };
      const chain = await m.call('bunqueue_add_flow_chain', {
        steps: [
          {
            name: 's1',
            queueName: 'flow',
            data: {},
            opts: { ...opts, removeOnFail: true, stallTimeout: 5000 },
          },
          { name: 's2', queueName: 'flow', data: {}, opts: { jobId: 'step-2' } },
        ],
      });
      expect(chain.json.jobIds).toEqual(['step-1', 'step-2']);
      // Over TCP the flow must land on the broker, never in an in-process engine.
      if (m.broker) expect(await m.broker.getJob(toJobId('step-1'))).not.toBeNull();
      const job = await m.call('bunqueue_get_job', { jobId: 'step-1' });
      expect(job.json).toMatchObject({ maxAttempts: 2, backoff: 300, timeout: 1000, lifo: true });
      expect(job.json).toMatchObject({ removeOnFail: true, stallTimeout: 5000 });

      const tree = await m.call('bunqueue_add_flow', {
        name: 'root',
        queueName: 'flow',
        opts: { jobId: 'root-1' },
        children: [{ name: 'kid', queueName: 'flow', opts: { jobId: 'kid-1', attempts: 4 } }],
      });
      expect(tree.json).toMatchObject({ jobId: 'root-1', children: [{ jobId: 'kid-1' }] });
      expect((await m.call('bunqueue_get_job', { jobId: 'kid-1' })).json.maxAttempts).toBe(4);

      const again = await m.call('bunqueue_add_flow', {
        name: 'x',
        queueName: 'flow',
        opts: { jobId: 'step-1' },
      });
      expect(again.isError).toBe(true);
      expect(again.json.error).toBe('Flow job step-1 already exists');
    });

    test('fan-out/fan-in steps take options and land on the same backend', async () => {
      const m = await mcp(mode);
      const r = await m.call('bunqueue_add_flow_bulk_then', {
        parallel: [
          { name: 'p1', queueName: 'fan', data: {}, opts: { jobId: 'p-1', priority: 5 } },
          {
            name: 'p2',
            queueName: 'fan',
            data: {},
            opts: { jobId: 'p-2', backoff: { type: 'fixed', delay: 50 } },
          },
        ],
        final: {
          name: 'f',
          queueName: 'fan',
          data: {},
          opts: { jobId: 'f-1', removeOnComplete: true },
        },
      });
      expect(r.json).toEqual({ parallelIds: ['p-1', 'p-2'], finalId: 'f-1' });
      if (m.broker) expect(await m.broker.getJob(toJobId('f-1'))).not.toBeNull();
      expect((await m.call('bunqueue_get_job', { jobId: 'p-1' })).json.priority).toBe(5);
      const p2 = await m.call('bunqueue_get_job', { jobId: 'p-2' });
      expect(p2.json.backoff).toEqual({ type: 'fixed', delay: 50 });
      const final = await m.call('bunqueue_get_job', { jobId: 'f-1' });
      expect(final.json).toMatchObject({ state: 'waiting-children', removeOnComplete: true });
    });
  });
}
