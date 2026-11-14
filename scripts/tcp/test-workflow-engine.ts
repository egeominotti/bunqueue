#!/usr/bin/env bun
import { runWorkflowContract } from '../shared/workflow-contract';

try {
  console.log('=== Test Workflow Engine (TCP Mode) ===');
  const { passed, failed } = await runWorkflowContract('tcp');
  console.log(`\n=== Summary ===\nPassed: ${passed}\nFailed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
