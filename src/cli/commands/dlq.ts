/**
 * DLQ Command Builders
 * Dead Letter Queue operations
 */

import { parseArgs } from 'node:util';
import {
  CommandError,
  requireArg,
  parseNumberArg,
  withoutOptionTerminator,
  splitSubcommand,
} from './types';

/** Build a DLQ subcommand */
export function buildDlqCommand(args: string[]): Record<string, unknown> {
  const { subcommand, subArgs } = splitSubcommand(args);
  if (!subcommand) {
    throw new CommandError('Missing subcommand. Use: list, retry, purge');
  }

  switch (subcommand) {
    case 'list':
      return buildDlqList(subArgs);
    case 'retry':
      return buildDlqRetry(subArgs);
    case 'purge':
      return buildDlqPurge(withoutOptionTerminator(subArgs));
    default:
      throw new CommandError(`Unknown dlq subcommand: ${subcommand}. Use: list, retry, purge`);
  }
}

function buildDlqList(args: string[]): Record<string, unknown> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      count: { type: 'string', short: 'c' },
    },
    allowPositionals: true,
    strict: false,
  });

  const queue = requireArg(positionals, 0, 'queue');

  const cmd: Record<string, unknown> = {
    cmd: 'Dlq',
    queue,
  };

  const count = parseNumberArg(values.count as string | undefined, 'count');
  if (count !== undefined) cmd.count = count;

  return cmd;
}

function buildDlqRetry(args: string[]): Record<string, unknown> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      id: { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  });

  const queue = requireArg(positionals, 0, 'queue');

  const cmd: Record<string, unknown> = {
    cmd: 'RetryDlq',
    queue,
  };

  if (values.id) cmd.jobId = values.id;

  return cmd;
}

function buildDlqPurge(args: string[]): Record<string, unknown> {
  const queue = requireArg(args, 0, 'queue');
  return { cmd: 'PurgeDlq', queue };
}
