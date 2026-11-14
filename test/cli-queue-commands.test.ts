/**
 * CLI Tests
 */

import { describe, test, expect } from 'bun:test';

describe('CLI', () => {
  describe('Queue Commands', () => {
    test('should build ListQueues command', async () => {
      const { buildQueueCommand } = await import('../src/cli/commands/queue');

      const cmd = buildQueueCommand(['list']);

      expect(cmd.cmd).toBe('ListQueues');
    });

    test('should build Pause command', async () => {
      const { buildQueueCommand } = await import('../src/cli/commands/queue');

      const cmd = buildQueueCommand(['pause', 'emails']);

      expect(cmd.cmd).toBe('Pause');
      expect(cmd.queue).toBe('emails');
    });

    test('should build Clean command', async () => {
      const { buildQueueCommand } = await import('../src/cli/commands/queue');

      const cmd = buildQueueCommand([
        'clean',
        'emails',
        '--grace',
        '3600000',
        '--state',
        'completed',
      ]);

      expect(cmd.cmd).toBe('Clean');
      expect(cmd.queue).toBe('emails');
      expect(cmd.grace).toBe(3600000);
      expect(cmd.state).toBe('completed');
    });

    test('should throw on missing grace for clean', async () => {
      const { buildQueueCommand } = await import('../src/cli/commands/queue');

      expect(() => buildQueueCommand(['clean', 'emails'])).toThrow('--grace is required');
    });

    test('should build GetJobs command', async () => {
      const { buildQueueCommand } = await import('../src/cli/commands/queue');

      const cmd = buildQueueCommand(['jobs', 'emails', '--state', 'waiting', '--limit', '10']);

      expect(cmd.cmd).toBe('GetJobs');
      expect(cmd.queue).toBe('emails');
      expect(cmd.state).toBe('waiting');
      expect(cmd.limit).toBe(10);
    });
  });

  describe('DLQ Commands', () => {
    test('should build Dlq list command', async () => {
      const { buildDlqCommand } = await import('../src/cli/commands/dlq');

      const cmd = buildDlqCommand(['list', 'emails', '--count', '50']);

      expect(cmd.cmd).toBe('Dlq');
      expect(cmd.queue).toBe('emails');
      expect(cmd.count).toBe(50);
    });

    test('should build RetryDlq command', async () => {
      const { buildDlqCommand } = await import('../src/cli/commands/dlq');

      const cmd = buildDlqCommand(['retry', 'emails', '--id', '123']);

      expect(cmd.cmd).toBe('RetryDlq');
      expect(cmd.queue).toBe('emails');
      expect(cmd.jobId).toBe('123');
    });

    test('should build PurgeDlq command', async () => {
      const { buildDlqCommand } = await import('../src/cli/commands/dlq');

      const cmd = buildDlqCommand(['purge', 'emails']);

      expect(cmd.cmd).toBe('PurgeDlq');
      expect(cmd.queue).toBe('emails');
    });
  });

  describe('Cron Commands', () => {
    test('should build CronList command', async () => {
      const { buildCronCommand } = await import('../src/cli/commands/cron');

      const cmd = buildCronCommand(['list']);

      expect(cmd.cmd).toBe('CronList');
    });

    test('should build Cron add command with schedule', async () => {
      const { buildCronCommand } = await import('../src/cli/commands/cron');

      const cmd = buildCronCommand([
        'add',
        'hourly-cleanup',
        '-q',
        'maintenance',
        '-d',
        '{"task":"cleanup"}',
        '-s',
        '0 * * * *',
      ]);

      expect(cmd.cmd).toBe('Cron');
      expect(cmd.name).toBe('hourly-cleanup');
      expect(cmd.queue).toBe('maintenance');
      expect(cmd.data).toEqual({ task: 'cleanup' });
      expect(cmd.schedule).toBe('0 * * * *');
    });

    test('should build Cron add command with repeatEvery', async () => {
      const { buildCronCommand } = await import('../src/cli/commands/cron');

      const cmd = buildCronCommand([
        'add',
        'health-check',
        '-q',
        'monitoring',
        '-d',
        '{}',
        '-e',
        '60000',
      ]);

      expect(cmd.cmd).toBe('Cron');
      expect(cmd.name).toBe('health-check');
      expect(cmd.repeatEvery).toBe(60000);
    });

    test('should throw on missing queue for cron add', async () => {
      const { buildCronCommand } = await import('../src/cli/commands/cron');

      expect(() => buildCronCommand(['add', 'test', '-d', '{}'])).toThrow(
        '--queue (-q) is required'
      );
    });

    test('should build CronDelete command', async () => {
      const { buildCronCommand } = await import('../src/cli/commands/cron');

      const cmd = buildCronCommand(['delete', 'hourly-cleanup']);

      expect(cmd.cmd).toBe('CronDelete');
      expect(cmd.name).toBe('hourly-cleanup');
    });
  });

  describe('Rate Limit Commands', () => {
    test('should build RateLimit set command', async () => {
      const { buildRateLimitCommand } = await import('../src/cli/commands/rateLimit');

      const cmd = buildRateLimitCommand('rate-limit', ['set', 'emails', '100']);

      expect(cmd.cmd).toBe('RateLimit');
      expect(cmd.queue).toBe('emails');
      expect(cmd.limit).toBe(100);
    });

    test('should build SetConcurrency command', async () => {
      const { buildRateLimitCommand } = await import('../src/cli/commands/rateLimit');

      const cmd = buildRateLimitCommand('concurrency', ['set', 'emails', '5']);

      expect(cmd.cmd).toBe('SetConcurrency');
      expect(cmd.queue).toBe('emails');
      expect(cmd.limit).toBe(5);
    });
  });
});
