/**
 * `tsconfig.test.json` excludes, by name, the test files whose remaining type errors
 * are genuine test defects that a type-only change cannot fix. That list may only
 * shrink: an excluded file gets no type checking at all, so a new entry would hide
 * every future error in it. Remove a file from both lists when its defect is fixed.
 */
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const REPO = join(import.meta.dir, '..');
const CONFIG = join(REPO, 'tsconfig.test.json');

/** Always excluded: not test sources. */
const BASE = ['node_modules', 'dist'];

/** The files excluded when the test tree became type-checked (2026-10-31). */
const ALLOWED = new Set([
  'test/bug-15-worker-event-types.test.ts',
  'test/cli-invariants-runtime.test.ts',
  'test/deduplicationRecovery.test.ts',
  'test/flow-producer-real-e2e.test.ts',
  'test/issue-82-moveToFailed.test.ts',
  'test/issue34-parent-result-missing.test.ts',
  'test/postgres-lease-renewal-batching.test.ts',
  'test/postgres-public-api-queue-worker.test.ts',
  'test/production-backpressure-torture.test.ts',
  'test/production-readiness-e2e.test.ts',
  'test/recoveryLogic.test.ts',
  'test/repro-defect-stale-ack-timeout-resurrection.test.ts',
  'test/repro-flow-producer-api-parity.test.ts',
  'test/retry-resilience.test.ts',
  'test/tcp-process-sweep-integrity.test.ts',
]);

/** Parsed with TypeScript's own JSONC reader, so comments and formatting cannot fool it. */
function config(): { include?: unknown; exclude?: unknown } {
  const parsed = ts.parseConfigFileTextToJson(CONFIG, readFileSync(CONFIG, 'utf8'));
  if (parsed.error)
    throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
  return parsed.config as { include?: unknown; exclude?: unknown };
}

test('the type-checked project still covers every source and test file', () => {
  expect(config().include).toEqual(['src/**/*', 'test/**/*']);
});

test('the exclusion list only ever shrinks', () => {
  const exclude = config().exclude;
  expect(Array.isArray(exclude)).toBe(true);
  const entries = exclude as string[];
  expect(entries.slice(0, BASE.length)).toEqual(BASE);
  // Any spelling or glob that is not an allowed exact path fails, e.g. `./test/x.ts`.
  const unexpected = entries.slice(BASE.length).filter((entry) => !ALLOWED.has(entry));
  expect(unexpected).toEqual([]);
});

test('every excluded test file still exists', () => {
  const entries = (config().exclude as string[]).slice(BASE.length);
  expect(entries.filter((file) => !existsSync(join(REPO, file)))).toEqual([]);
});
