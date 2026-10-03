import { jobId } from '../domain/types/job';
import { getSharedManager } from './manager';
import { buildFailCommand, failEmbeddedArgs } from './queue/failWire';
import { assertFlowTcpOk, type FlowJobRuntime } from './flowJobTypes';
import { removeJobDeduplicationKey } from './jobDeduplication';
import { waitJobUntilFinished } from './jobWait';

/** Lifecycle and failure-inspection methods exposed by a FlowProducer Job. */
export function buildFlowJobMoveMethods(runtime: FlowJobRuntime) {
  const { id, embedded, tcp } = runtime;
  return {
    moveToCompleted: async (returnValue: unknown, token?: string) => {
      if (embedded) {
        await getSharedManager().ack(jobId(id), returnValue, token);
        return null;
      }
      if (tcp) {
        assertFlowTcpOk(
          await tcp.send({
            cmd: 'ACK',
            id,
            result: returnValue,
            ...(token === undefined ? {} : { token }),
          }),
          'ACK'
        );
      }
      return null;
    },
    moveToFailed: async (error: Error, token?: string) => {
      if (embedded) {
        await getSharedManager().fail(jobId(id), ...failEmbeddedArgs(error, token));
        return;
      }
      if (tcp) assertFlowTcpOk(await tcp.send(buildFailCommand(id, error, token)), 'FAIL');
    },
    moveToWait: async (token?: string) => {
      if (embedded) return getSharedManager().moveActiveToWait(jobId(id), token);
      if (!tcp) return false;
      assertFlowTcpOk(
        await tcp.send({ cmd: 'MoveToWait', id, ...(token === undefined ? {} : { token }) }),
        'MoveToWait'
      );
      return true;
    },
    moveToDelayed: async (timestamp: number, token?: string) => {
      const delay = Math.max(0, timestamp - Date.now());
      if (embedded) return void (await getSharedManager().moveToDelayed(jobId(id), delay, token));
      if (!tcp) return;
      assertFlowTcpOk(
        await tcp.send({
          cmd: 'MoveToDelayed',
          id,
          delay,
          ...(token === undefined ? {} : { token }),
        }),
        'MoveToDelayed'
      );
    },
    moveToWaitingChildren: async (token?: string) => {
      if (embedded) return getSharedManager().moveToWaitingChildren(jobId(id), token);
      if (!tcp) return false;
      const response = await tcp.send({
        cmd: 'MoveToWaitingChildren',
        id,
        ...(token === undefined ? {} : { token }),
      });
      assertFlowTcpOk(response, 'MoveToWaitingChildren');
      return true;
    },
    waitUntilFinished: (queueEvents: unknown, ttl?: number) =>
      waitJobUntilFinished(runtime, id, queueEvents, ttl),
    discard: () => {
      if (embedded) void getSharedManager().discard(jobId(id));
      else if (tcp) void tcp.send({ cmd: 'Discard', id });
    },
    getFailedChildrenValues: async () => {
      if (embedded) return getSharedManager().getFailedChildrenValues(jobId(id));
      if (!tcp) return {};
      const response = await tcp.send({ cmd: 'GetFailedChildrenValues', id });
      assertFlowTcpOk(response, 'GetFailedChildrenValues');
      return (response.values as Record<string, string> | undefined) ?? {};
    },
    getIgnoredChildrenFailures: async () => {
      if (embedded) return getSharedManager().getIgnoredChildrenFailures(jobId(id));
      if (!tcp) return {};
      const response = await tcp.send({ cmd: 'GetIgnoredChildrenFailures', id });
      assertFlowTcpOk(response, 'GetIgnoredChildrenFailures');
      return (response.values as Record<string, string> | undefined) ?? {};
    },
    removeChildDependency: async () => {
      if (embedded) return getSharedManager().removeChildDependency(jobId(id));
      if (!tcp) return false;
      const response = await tcp.send({ cmd: 'RemoveChildDependency', id });
      assertFlowTcpOk(response, 'RemoveChildDependency');
      return (response.removed as boolean | undefined) ?? false;
    },
    removeDeduplicationKey: () => removeJobDeduplicationKey(id, embedded, tcp),
    removeUnprocessedChildren: async () => {
      if (embedded) return void (await getSharedManager().removeUnprocessedChildren(jobId(id)));
      if (!tcp) return;
      assertFlowTcpOk(
        await tcp.send({ cmd: 'RemoveUnprocessedChildren', id }),
        'RemoveUnprocessedChildren'
      );
    },
  };
}
