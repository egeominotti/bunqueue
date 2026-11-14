/**
 * CLI Tests
 */

import { describe, test, expect } from 'bun:test';

describe('CLI', () => {
  describe('Worker Commands', () => {
    test('should build ListWorkers command', async () => {
      const { buildWorkerCommand } = await import('../src/cli/commands/worker');

      const cmd = buildWorkerCommand(['list']);

      expect(cmd.cmd).toBe('ListWorkers');
    });

    test('should build RegisterWorker command', async () => {
      const { buildWorkerCommand } = await import('../src/cli/commands/worker');

      const cmd = buildWorkerCommand(['register', 'worker-1', '-q', 'emails,tasks']);

      expect(cmd.cmd).toBe('RegisterWorker');
      expect(cmd.name).toBe('worker-1');
      expect(cmd.queues).toEqual(['emails', 'tasks']);
    });
  });

  describe('Webhook Commands', () => {
    test('should build AddWebhook command', async () => {
      const { buildWebhookCommand } = await import('../src/cli/commands/webhook');

      const cmd = buildWebhookCommand([
        'add',
        'https://example.com/webhook',
        '-e',
        'job.completed,job.failed',
        '-q',
        'emails',
      ]);

      expect(cmd.cmd).toBe('AddWebhook');
      expect(cmd.url).toBe('https://example.com/webhook');
      expect(cmd.events).toEqual(['job.completed', 'job.failed']);
      expect(cmd.queue).toBe('emails');
    });
  });

  describe('Monitor Commands', () => {
    test('should build Stats command', async () => {
      const { buildMonitorCommand } = await import('../src/cli/commands/monitor');

      const cmd = buildMonitorCommand('stats');

      expect(cmd.cmd).toBe('Stats');
    });

    test('should build Prometheus command for metrics', async () => {
      const { buildMonitorCommand } = await import('../src/cli/commands/monitor');

      const cmd = buildMonitorCommand('metrics');

      expect(cmd.cmd).toBe('Prometheus');
    });
  });

  describe('Output Formatting', () => {
    test('should format job response', async () => {
      const { formatOutput } = await import('../src/cli/output');

      const response = {
        ok: true,
        job: {
          id: '123',
          queue: 'emails',
          state: 'waiting',
          priority: 0,
          attempts: 0,
          maxAttempts: 3,
          data: { to: 'test@test.com' },
        },
      };

      const output = formatOutput(response, 'pull', false);
      expect(output).toContain('Job:');
      expect(output).toContain('123');
      expect(output).toContain('emails');
    });

    test('should format as JSON when requested', async () => {
      const { formatOutput } = await import('../src/cli/output');

      const response = { ok: true, id: '123' };
      const output = formatOutput(response, 'push', true);

      const parsed = JSON.parse(output);
      expect(parsed.ok).toBe(true);
      expect(parsed.id).toBe('123');
    });

    test('should format error response', async () => {
      const { formatOutput } = await import('../src/cli/output');

      const response = { ok: false, error: 'Job not found' };
      const output = formatOutput(response, 'job', false);

      expect(output).toContain('Error');
      expect(output).toContain('Job not found');
    });

    test('should format stats response', async () => {
      const { formatOutput } = await import('../src/cli/output');

      const response = {
        ok: true,
        stats: {
          waiting: 10,
          active: 5,
          delayed: 2,
          completed: 100,
          failed: 3,
          dlq: 1,
        },
      };

      const output = formatOutput(response, 'stats', false);
      expect(output).toContain('Statistics');
      expect(output).toContain('Waiting');
      expect(output).toContain('10');
    });

    test('should format empty job list', async () => {
      const { formatOutput } = await import('../src/cli/output');

      const response = { ok: true, jobs: [] };
      const output = formatOutput(response, 'queue', false);

      expect(output).toContain('No jobs found');
    });

    test('should format queues list', async () => {
      const { formatOutput } = await import('../src/cli/output');

      const response = { ok: true, queues: ['emails', 'tasks', 'notifications'] };
      const output = formatOutput(response, 'queue', false);

      expect(output).toContain('emails');
      expect(output).toContain('tasks');
      expect(output).toContain('notifications');
    });
  });
});
