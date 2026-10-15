/**
 * Worker Command Builders
 * Worker management operations
 */

import { parseArgs } from 'node:util';
import { CommandError, requireArg, withoutOptionTerminator, splitSubcommand } from './types';

/** Build a worker subcommand */
export function buildWorkerCommand(args: string[]): Record<string, unknown> {
  const { subcommand, subArgs } = splitSubcommand(args);
  if (!subcommand) {
    throw new CommandError('Missing subcommand. Use: list, register, unregister');
  }

  switch (subcommand) {
    case 'list':
      return { cmd: 'ListWorkers' };
    case 'register':
      return buildRegisterWorker(subArgs);
    case 'unregister':
      return buildUnregisterWorker(withoutOptionTerminator(subArgs));
    default:
      throw new CommandError(
        `Unknown worker subcommand: ${subcommand}. Use: list, register, unregister`
      );
  }
}

function buildRegisterWorker(args: string[]): Record<string, unknown> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      queues: { type: 'string', short: 'q' },
    },
    allowPositionals: true,
    strict: false,
  });

  const name = requireArg(positionals, 0, 'name');

  if (!values.queues) {
    throw new CommandError('--queues (-q) is required (comma-separated queue names)');
  }

  const queues = (values.queues as string).split(',').filter(Boolean);
  if (queues.length === 0) {
    throw new CommandError('At least one queue must be specified');
  }

  return {
    cmd: 'RegisterWorker',
    name,
    queues,
  };
}

function buildUnregisterWorker(args: string[]): Record<string, unknown> {
  const workerId = requireArg(args, 0, 'workerId');
  return { cmd: 'UnregisterWorker', workerId };
}
