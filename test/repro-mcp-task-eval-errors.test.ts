import { expect, test } from 'bun:test';
import { offlineDriver } from '../scripts/mcp-eval/offline-driver';
import { aggregateTaskResults, runTaskEvaluation } from '../scripts/mcp-eval/task-eval';

for (const mode of ['embedded', 'tcp'] as const) {
  for (const failure of [new Error(''), ''] as const) {
    const kind = failure instanceof Error ? 'empty Error' : 'empty string';
    test(`evaluation fails closed after successful actions followed by ${kind} (${mode})`, async () => {
      let attempted = 0;
      const results = await runTaskEvaluation({
        modes: [mode],
        driver: {
          name: 'completed-actions-then-empty-failure',
          async run(context) {
            attempted++;
            await offlineDriver.run(context);
            throw failure;
          },
        },
      });
      expect(attempted).toBe(5);
      expect(results).toHaveLength(5);
      for (const result of results) {
        expect(result.calls).toBeGreaterThan(0);
        expect(result.checks.every((check) => check.passed)).toBe(true);
        expect(result.error).toBeDefined();
        expect(result.passed).toBe(false);
      }
      expect(aggregateTaskResults(results)).toMatchObject({
        passed: false,
        failed: 5,
        exitCode: 1,
      });
    });
  }
}
