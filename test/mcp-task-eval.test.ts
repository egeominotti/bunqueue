import { describe, expect, test } from 'bun:test';
import { offlineDriver } from '../scripts/mcp-eval/offline-driver';
import { openTaskHarness } from '../scripts/mcp-eval/task-harness';
import { existsSync } from 'node:fs';
import { peekSharedManager } from '../src/client/manager';

import * as evaluation from '../scripts/mcp-eval/task-eval';

test('aggregation fails when a task fails or no tasks were evaluated', () => {
  const failed = {
    scenario: 'incomplete',
    mode: 'embedded' as const,
    driver: 'test',
    passed: false,
    checks: [{ name: 'final state', passed: false }],
    calls: 0,
    elapsedMs: 1,
    responseBytes: 0,
  };
  expect(evaluation.aggregateTaskResults([failed])).toMatchObject({
    passed: false,
    exitCode: 1,
    total: 1,
    failed: 1,
  });
  expect(evaluation.aggregateTaskResults([])).toMatchObject({ passed: false, exitCode: 1 });
});

test('cleanup releases the fixture database even when backend shutdown throws', async () => {
  const harness = await openTaskHarness('embedded');
  const shutdown = harness.backend.shutdown.bind(harness.backend);
  harness.backend.shutdown = () => {
    shutdown();
    throw new Error('cleanup interrupted');
  };
  await expect(harness.close()).rejects.toThrow('cleanup');
  expect(existsSync(harness.dir)).toBe(false);
  expect(peekSharedManager()).toBeNull();
});

for (const mode of ['embedded', 'tcp'] as const) {
  describe(`observable MCP task evaluation (${mode})`, () => {
    test('offline driver completes real tasks and verifies independent final state', async () => {
      const results = await evaluation.runTaskEvaluation({ modes: [mode] });
      expect(results).toHaveLength(5);
      expect(evaluation.aggregateTaskResults(results)).toMatchObject({
        passed: true,
        exitCode: 0,
        total: 5,
        failed: 0,
      });
      for (const result of results) {
        expect(result.checks.length).toBeGreaterThan(1);
        expect(result.checks.every((check) => check.passed)).toBe(true);
        expect(result.calls).toBeGreaterThan(0);
        expect(result.responseBytes).toBeGreaterThan(0);
      }
    });

    test('a driver that does nothing cannot pass by returning success', async () => {
      const results = await evaluation.runTaskEvaluation({
        modes: [mode],
        driver: { name: 'no-op', run: async () => ({ evidence: { success: true } }) },
      });
      expect(results.every((result) => !result.passed)).toBe(true);
      expect(evaluation.aggregateTaskResults(results).exitCode).toBe(1);
    });

    test('a driver failure is recorded and later scenarios are still evaluated', async () => {
      const results = await evaluation.runTaskEvaluation({
        modes: [mode],
        driver: {
          name: 'broken',
          run: async () => {
            throw new Error('driver interrupted');
          },
        },
      });
      expect(results).toHaveLength(5);
      expect(results.every((result) => result.error === 'driver interrupted')).toBe(true);
      expect(evaluation.aggregateTaskResults(results)).toMatchObject({ failed: 5, exitCode: 1 });
    });

    test('dynamic fallback calls are graded on their actual target and final state', async () => {
      const results = await evaluation.runTaskEvaluation({
        modes: [mode],
        driver: {
          name: 'fallback',
          run: (context) =>
            offlineDriver.run({
              ...context,
              call: (name, args) =>
                name === 'bunqueue_enable_toolsets'
                  ? context.call(name, args)
                  : context.call('bunqueue_call_tool', { name, arguments: args }),
            }),
        },
      });
      expect(evaluation.aggregateTaskResults(results).passed).toBe(true);
    });
  });
}
