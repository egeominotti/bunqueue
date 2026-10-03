/** Shared doubles for the job proxy tests (test/jobProxy*.test.ts). */
import type { TcpConnectionPool } from '../../src/client/tcpPool';
import type { JobStateType } from '../../src/client/types';

/** A recording transport that stands in for the job proxy's TcpConnectionPool. */
export function createMockTcp() {
  const calls: Record<string, unknown>[] = [];
  const tcp = {
    send: async (cmd: Record<string, unknown>): Promise<Record<string, unknown>> => {
      calls.push(cmd);
      if (cmd.cmd === 'RemoveJobDeduplicationKey') return { ok: true, data: { removed: true } };
      return { ok: true };
    },
  };
  return { calls, tcp: tcp as typeof tcp & TcpConnectionPool };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createMockCtx(overrides: Record<string, any> = {}) {
  const { tcp, calls } = createMockTcp();
  return {
    calls,
    ctx: {
      queueName: overrides.queueName ?? 'test-queue',
      tcp: overrides.tcp ?? tcp,
      getJobState: overrides.getJobState ?? (async () => 'waiting' as JobStateType),
      removeAsync: overrides.removeAsync ?? (async () => {}),
      retryJob: overrides.retryJob ?? (async () => {}),
      getChildrenValues: overrides.getChildrenValues ?? (async () => ({})),
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createSimpleCtx(overrides: Record<string, any> = {}) {
  return {
    queueName: overrides.queueName ?? 'test-queue',
    getJobState: overrides.getJobState ?? (async () => 'waiting' as JobStateType),
    removeAsync: overrides.removeAsync ?? (async () => {}),
    retryJob: overrides.retryJob ?? (async () => {}),
    getChildrenValues: overrides.getChildrenValues ?? (async () => ({})),
  };
}
