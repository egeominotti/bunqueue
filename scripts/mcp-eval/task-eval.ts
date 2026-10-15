#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import { offlineDriver } from './offline-driver';
import { openTaskHarness } from './task-harness';
import { seedScenario, TASK_SCENARIOS, verifyScenario } from './task-scenarios';
import type { DriverOutput, EvalMode, TaskDriver, TaskResult } from './task-types';

export function aggregateTaskResults(results: TaskResult[]) {
  const failed = results.filter((result) => !result.passed).length;
  const passed = results.length > 0 && failed === 0;
  return { passed, exitCode: passed ? 0 : 1, total: results.length, failed };
}

export async function runTaskEvaluation(
  options: {
    modes?: EvalMode[];
    driver?: TaskDriver;
  } = {}
): Promise<TaskResult[]> {
  const driver = options.driver ?? offlineDriver;
  const results: TaskResult[] = [];
  // Embedded mode owns a singleton; sequential fresh fixtures also simplify observation.
  for (const mode of options.modes ?? ['embedded', 'tcp']) {
    for (const scenario of TASK_SCENARIOS) {
      const started = performance.now();
      const result: TaskResult = {
        scenario: scenario.id,
        mode,
        driver: driver.name,
        passed: false,
        checks: [],
        calls: 0,
        elapsedMs: 0,
        responseBytes: 0,
      };
      let harness: Awaited<ReturnType<typeof openTaskHarness>> | undefined;
      try {
        harness = await openTaskHarness(mode, { BUNQUEUE_MCP_PROFILE: 'agent' });
        const queue = `eval-${scenario.id}-${randomUUID()}`;
        const jobIds = await seedScenario(scenario.id, harness.backend, queue);
        let output: DriverOutput | undefined;
        let driverFailed = false;
        try {
          output = await driver.run({
            scenario: scenario.id,
            request: scenario.request,
            queue,
            jobIds,
            call: harness.call,
            listTools: harness.listTools,
          });
        } catch (error) {
          driverFailed = true;
          result.error = error instanceof Error ? error.message : String(error);
        }
        result.checks = await verifyScenario(
          scenario.id,
          harness.backend,
          queue,
          jobIds,
          harness.calls
        );
        result.usage = output?.usage;
        result.passed = !driverFailed && result.checks.every((check) => check.passed);
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
      } finally {
        result.calls = harness?.calls.length ?? 0;
        result.responseBytes = harness?.responseBytes() ?? 0;
        try {
          await harness?.close();
        } catch (error) {
          result.passed = false;
          result.error = `Cleanup failed: ${String(error)}`;
        }
        result.elapsedMs = Math.round((performance.now() - started) * 100) / 100;
      }
      results.push(result);
    }
  }
  return results;
}

if (import.meta.main) {
  const results = await runTaskEvaluation();
  const summary = aggregateTaskResults(results);
  console.log(JSON.stringify({ kind: 'offline-functional-tasks', summary, results }, null, 2));
  process.exitCode = summary.exitCode;
}
