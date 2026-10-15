import { expect, test } from 'bun:test';

import * as measurement from '../scripts/mcp-eval/catalog-measurement';

test('context measurement includes complete current descriptors and real dynamic disclosures', async () => {
  const report = await measurement.measureCatalog();
  expect(report.primary.toolCount).toBe(79);
  expect(report.primary.bytes).toBeGreaterThan(100000);
  expect(report.primary.approxTokens).toBe(Math.ceil(report.primary.bytes / 4));
  expect(report.agentInitial.toolCount).toBe(2);
  expect(report.dynamic.every((item) => item.completeSchemas)).toBe(true);
  expect(report.dynamic.find((item) => item.toolset === 'jobs')?.disclosureBytes).toBeGreaterThan(
    10000
  );
  expect(report.optionalWorkflows.map((item) => item.toolCount)).toEqual([2, 3]);
  expect(report.optionalWorkflows.every((item) => item.disclosureBytes > item.bytes)).toBe(true);
});
