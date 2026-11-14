/**
 * CLI Tests
 */

import { describe, test, expect } from 'bun:test';

describe('CLI', () => {
  describe('Command Types', () => {
    test('should throw CommandError for missing required argument', async () => {
      const { requireArg, CommandError } = await import('../src/cli/commands/types');

      expect(() => requireArg([], 0, 'queue')).toThrow(CommandError);
      expect(() => requireArg([], 0, 'queue')).toThrow('Missing required argument: queue');
    });

    test('should return argument when present', async () => {
      const { requireArg } = await import('../src/cli/commands/types');

      expect(requireArg(['myqueue'], 0, 'queue')).toBe('myqueue');
      expect(requireArg(['a', 'b', 'c'], 1, 'second')).toBe('b');
    });

    test('should parse valid JSON', async () => {
      const { parseJsonArg } = await import('../src/cli/commands/types');

      expect(parseJsonArg('{"name":"test"}', 'data')).toEqual({ name: 'test' });
      expect(parseJsonArg('[1,2,3]', 'array')).toEqual([1, 2, 3]);
      expect(parseJsonArg('"string"', 'str')).toBe('string');
      expect(parseJsonArg('123', 'num')).toBe(123);
    });

    test('should throw on invalid JSON', async () => {
      const { parseJsonArg, CommandError } = await import('../src/cli/commands/types');

      expect(() => parseJsonArg('{invalid}', 'data')).toThrow(CommandError);
      expect(() => parseJsonArg('not json', 'data')).toThrow('Invalid JSON');
    });

    test('should parse number argument', async () => {
      const { parseNumberArg } = await import('../src/cli/commands/types');

      expect(parseNumberArg('123', 'priority')).toBe(123);
      expect(parseNumberArg('0', 'delay')).toBe(0);
      expect(parseNumberArg('-10', 'offset')).toBe(-10);
      expect(parseNumberArg(undefined, 'optional')).toBeUndefined();
    });

    test('should throw on invalid number', async () => {
      const { parseNumberArg, CommandError } = await import('../src/cli/commands/types');

      expect(() => parseNumberArg('abc', 'priority')).toThrow(CommandError);
      expect(() => parseNumberArg('not-a-number', 'count')).toThrow('Invalid number');
    });
  });

  describe('Core Commands', () => {
    test('should build PUSH command with all options', async () => {
      const { buildCoreCommand } = await import('../src/cli/commands/core');

      const cmd = buildCoreCommand('push', [
        'emails',
        '{"to":"test@test.com"}',
        '--priority',
        '10',
        '--delay',
        '5000',
        '--max-attempts',
        '5',
        '--unique-key',
        'email-123',
        '--tags',
        'urgent,email',
      ]);

      expect(cmd.cmd).toBe('PUSH');
      expect(cmd.queue).toBe('emails');
      expect(cmd.data).toEqual({ to: 'test@test.com' });
      expect(cmd.priority).toBe(10);
      expect(cmd.delay).toBe(5000);
      expect(cmd.maxAttempts).toBe(5);
      expect(cmd.uniqueKey).toBe('email-123');
      expect(cmd.tags).toEqual(['urgent', 'email']);
    });

    test('should build minimal PUSH command', async () => {
      const { buildCoreCommand } = await import('../src/cli/commands/core');

      const cmd = buildCoreCommand('push', ['tasks', '{"action":"sync"}']);

      expect(cmd.cmd).toBe('PUSH');
      expect(cmd.queue).toBe('tasks');
      expect(cmd.data).toEqual({ action: 'sync' });
      expect(cmd.priority).toBeUndefined();
      expect(cmd.delay).toBeUndefined();
    });

    test('should build PULL command', async () => {
      const { buildCoreCommand } = await import('../src/cli/commands/core');

      const cmd = buildCoreCommand('pull', ['myqueue', '--timeout', '3000']);

      expect(cmd.cmd).toBe('PULL');
      expect(cmd.queue).toBe('myqueue');
      expect(cmd.timeout).toBe(3000);
    });

    test('should build PULL command without timeout', async () => {
      const { buildCoreCommand } = await import('../src/cli/commands/core');

      const cmd = buildCoreCommand('pull', ['myqueue']);

      expect(cmd.cmd).toBe('PULL');
      expect(cmd.queue).toBe('myqueue');
      expect(cmd.timeout).toBeUndefined();
    });

    test('should build ACK command', async () => {
      const { buildCoreCommand } = await import('../src/cli/commands/core');

      const cmd = buildCoreCommand('ack', ['123', '--result', '{"success":true}']);

      expect(cmd.cmd).toBe('ACK');
      expect(cmd.id).toBe('123');
      expect(cmd.result).toEqual({ success: true });
    });

    test('should build FAIL command', async () => {
      const { buildCoreCommand } = await import('../src/cli/commands/core');

      const cmd = buildCoreCommand('fail', ['456', '--error', 'Processing failed']);

      expect(cmd.cmd).toBe('FAIL');
      expect(cmd.id).toBe('456');
      expect(cmd.error).toBe('Processing failed');
    });

    test('should throw on missing queue', async () => {
      const { buildCoreCommand } = await import('../src/cli/commands/core');

      expect(() => buildCoreCommand('push', [])).toThrow('Missing required argument: queue');
    });

    test('should throw on missing data', async () => {
      const { buildCoreCommand } = await import('../src/cli/commands/core');

      expect(() => buildCoreCommand('push', ['queue'])).toThrow('Missing required argument: data');
    });
  });

  describe('Job Commands', () => {
    test('should build GetJob command', async () => {
      const { buildJobCommand } = await import('../src/cli/commands/job');

      const cmd = buildJobCommand(['get', '12345']);

      expect(cmd.cmd).toBe('GetJob');
      expect(cmd.id).toBe('12345');
    });

    test('should build Progress command', async () => {
      const { buildJobCommand } = await import('../src/cli/commands/job');

      const cmd = buildJobCommand(['progress', '123', '50', '--message', 'Halfway done']);

      expect(cmd.cmd).toBe('Progress');
      expect(cmd.id).toBe('123');
      expect(cmd.progress).toBe(50);
      expect(cmd.message).toBe('Halfway done');
    });

    test('should build ChangePriority command', async () => {
      const { buildJobCommand } = await import('../src/cli/commands/job');

      const cmd = buildJobCommand(['priority', '123', '100']);

      expect(cmd.cmd).toBe('ChangePriority');
      expect(cmd.id).toBe('123');
      expect(cmd.priority).toBe(100);
    });

    test('should build AddLog command', async () => {
      const { buildJobCommand } = await import('../src/cli/commands/job');

      const cmd = buildJobCommand(['log', '123', 'Processing started', '--level', 'info']);

      expect(cmd.cmd).toBe('AddLog');
      expect(cmd.id).toBe('123');
      expect(cmd.message).toBe('Processing started');
      expect(cmd.level).toBe('info');
    });

    test('should throw on invalid log level', async () => {
      const { buildJobCommand } = await import('../src/cli/commands/job');

      expect(() => buildJobCommand(['log', '123', 'msg', '--level', 'invalid'])).toThrow(
        'Invalid log level'
      );
    });

    test('should throw on unknown job subcommand', async () => {
      const { buildJobCommand } = await import('../src/cli/commands/job');

      expect(() => buildJobCommand(['unknown'])).toThrow('Unknown job subcommand');
    });
  });
});
