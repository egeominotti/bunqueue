/**
 * CLI Command Types
 * Shared types and utilities for command builders
 */

/** Error thrown when command building fails */
export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}

/** Direct positional builders remove the parser marker, preserving later literal `--` values. */
export function withoutOptionTerminator(args: string[]): string[] {
  const index = args.indexOf('--');
  return index < 0 ? args : [...args.slice(0, index), ...args.slice(index + 1)];
}

/** A family-level terminator protects subcommand arguments after dispatch as well. */
export function splitSubcommand(args: string[]): { subcommand?: string; subArgs: string[] } {
  return args[0] === '--'
    ? { subcommand: args[1], subArgs: ['--', ...args.slice(2)] }
    : { subcommand: args[0], subArgs: args.slice(1) };
}

/** Bun's permissive argument parser returns strings for explicit boolean assignments. */
export function parseBooleanArg(value: unknown, name: string): boolean {
  if (value === undefined || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  throw new CommandError(`Invalid boolean for --${name}: use --${name}=true or --${name}=false`);
}

/** Require a positional argument */
export function requireArg(args: string[], index: number, name: string): string {
  const value = args[index];
  if (!value) {
    throw new CommandError(`Missing required argument: ${name}`);
  }
  return value;
}

/** Parse JSON argument safely */
export function parseJsonArg(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new CommandError(`Invalid JSON for ${name}: ${value}`);
  }
}

/** Parse number argument */
export function parseNumberArg(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value)) {
    throw new CommandError(`Invalid number for ${name}: ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CommandError(`Invalid number for ${name}: ${value}`);
  }
  return parsed === 0 ? 0 : parsed;
}

/** Parse job ID argument (UUIDs, numeric IDs, or custom IDs) */
export function parseBigIntArg(value: string, name: string): string {
  // Return as string, server will parse it
  if (!value || value.trim().length === 0) {
    throw new CommandError(`Invalid ID for ${name}: ${value}`);
  }
  return value;
}
