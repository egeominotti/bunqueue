import type { Socket } from 'bun';
import type { Command } from '../../../domain/types/command';
import type { Response } from '../../../domain/types/response';
import * as resp from '../../../domain/types/response';
import { validateQueueName } from '../protocol';
import type { TcpConnectionData } from '../types/tcpServer';
import type { TcpConnectionRegistry } from './connections';
import { validateEventTypes } from './eventFanout';

type EventCommand = Extract<Command, { cmd: 'SubscribeEvents' | 'UnsubscribeEvents' }>;

export function handleEventSubscription(
  command: EventCommand,
  socket: Socket<TcpConnectionData>,
  registry: TcpConnectionRegistry
): Response {
  const { ctx } = socket.data;
  if (ctx.authTokens.size > 0 && !ctx.authenticated) {
    return resp.error('Not authenticated', command.reqId);
  }

  if (command.cmd === 'UnsubscribeEvents') {
    registry.unsubscribeEvents(socket);
    return resp.ok(undefined, command.reqId);
  }

  const validationError = validateQueueName(command.queue);
  if (validationError) return resp.error(validationError, command.reqId);
  const eventTypesError = validateEventTypes(command.eventTypes);
  if (eventTypesError) return resp.error(eventTypesError, command.reqId);
  registry.subscribeEvents(socket, command.queue, command.eventTypes);
  return resp.ok(undefined, command.reqId);
}
