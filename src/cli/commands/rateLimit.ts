/**
 * Rate Limit Command Builders
 * Rate limiting and concurrency control operations
 */

import {
  CommandError,
  requireArg,
  parseNumberArg,
  withoutOptionTerminator,
  splitSubcommand,
} from './types';

/** Build a rate-limit or concurrency command */
export function buildRateLimitCommand(command: string, args: string[]): Record<string, unknown> {
  const { subcommand, subArgs: protectedArgs } = splitSubcommand(args);
  if (!subcommand) {
    throw new CommandError(`Missing subcommand for ${command}. Use: set, clear`);
  }
  const subArgs = withoutOptionTerminator(protectedArgs);

  if (command === 'rate-limit') {
    switch (subcommand) {
      case 'set':
        return buildRateLimitSet(subArgs);
      case 'clear':
        return buildRateLimitClear(subArgs);
      default:
        throw new CommandError(`Unknown rate-limit subcommand: ${subcommand}. Use: set, clear`);
    }
  } else if (command === 'concurrency') {
    switch (subcommand) {
      case 'set':
        return buildConcurrencySet(subArgs);
      case 'clear':
        return buildConcurrencyClear(subArgs);
      default:
        throw new CommandError(`Unknown concurrency subcommand: ${subcommand}. Use: set, clear`);
    }
  }

  throw new CommandError(`Unknown command: ${command}`);
}

function buildRateLimitSet(args: string[]): Record<string, unknown> {
  const queue = requireArg(args, 0, 'queue');
  const limit = parseNumberArg(requireArg(args, 1, 'limit'), 'limit');

  if (limit === undefined || limit <= 0) {
    throw new CommandError('Limit must be a positive number (jobs per second)');
  }

  return {
    cmd: 'RateLimit',
    queue,
    limit,
  };
}

function buildRateLimitClear(args: string[]): Record<string, unknown> {
  const queue = requireArg(args, 0, 'queue');
  return { cmd: 'RateLimitClear', queue };
}

function buildConcurrencySet(args: string[]): Record<string, unknown> {
  const queue = requireArg(args, 0, 'queue');
  const limit = parseNumberArg(requireArg(args, 1, 'limit'), 'limit');

  if (limit === undefined || limit <= 0) {
    throw new CommandError('Limit must be a positive number (max concurrent jobs)');
  }

  return {
    cmd: 'SetConcurrency',
    queue,
    limit,
  };
}

function buildConcurrencyClear(args: string[]): Record<string, unknown> {
  const queue = requireArg(args, 0, 'queue');
  return { cmd: 'ClearConcurrency', queue };
}
