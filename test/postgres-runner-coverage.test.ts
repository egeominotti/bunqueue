/**
 * Guard: every test that needs PostgreSQL is selected by `bun run test:postgres`.
 *
 * PostgreSQL cases skip unless `BUNQUEUE_TEST_POSTGRES_URL` is set, and only the
 * PostgreSQL runner (`scripts/test-postgres.ts`, CI job `test-postgres`) sets it. Four
 * files that read the URL but were not named `postgres-*.test.ts` were therefore skipped
 * in every run. A test file needs PostgreSQL when it reads the URL itself or imports,
 * directly or through other test modules, a module that reads it.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { postgresTestCommand } from '../scripts/test-postgres';

const ROOT = join(import.meta.dir, '..');
const READS_URL =
  /\benv(?:\.BUNQUEUE_TEST_POSTGRES_URL\b|\[\s*['"`]BUNQUEUE_TEST_POSTGRES_URL['"`]\s*\])/;
const RELATIVE_IMPORT = /\b(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;

function testTreeSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const file of new Bun.Glob('test/**/*.{ts,tsx}').scanSync({ cwd: ROOT, onlyFiles: true })) {
    sources.set(file, readFileSync(join(ROOT, file), 'utf8'));
  }
  return sources;
}

function resolveImport(from: string, specifier: string, sources: Map<string, string>) {
  const base = normalize(join(dirname(from), specifier));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')];
  return candidates.find((candidate) => sources.has(candidate));
}

/** Test files that read the PostgreSQL test URL, directly or through their imports. */
function postgresGatedTestFiles(sources: Map<string, string>): string[] {
  const imports = new Map<string, string[]>();
  for (const [file, text] of sources) {
    const resolved = [...text.matchAll(RELATIVE_IMPORT)]
      .map((match) => resolveImport(file, match[1], sources))
      .filter((target): target is string => target !== undefined);
    imports.set(file, resolved);
  }
  const gated = new Set([...sources].filter(([, text]) => READS_URL.test(text)).map(([f]) => f));
  for (let grew = true; grew;) {
    grew = false;
    for (const [file, targets] of imports) {
      if (gated.has(file) || !targets.some((target) => gated.has(target))) continue;
      gated.add(file);
      grew = true;
    }
  }
  return [...gated].filter((file) => file.endsWith('.test.ts')).sort();
}

function postgresRunnerSelection(): Set<string> {
  return new Set(postgresTestCommand('postgres://configured', []).slice(2));
}

describe('the PostgreSQL runner selects every test that needs PostgreSQL', () => {
  test('no test reading BUNQUEUE_TEST_POSTGRES_URL is left outside test:postgres', () => {
    const selected = postgresRunnerSelection();
    const missing = postgresGatedTestFiles(testTreeSources()).filter((f) => !selected.has(f));
    expect(missing).toEqual([]);
  });

  test('the detector finds direct and imported reads and ignores mere mentions', () => {
    const gated = postgresGatedTestFiles(testTreeSources());
    for (const file of [
      'test/repro-postgres-own-terminal-refresh.test.ts',
      'test/repro-postgres-cron-native-persisted-migration.test.ts',
      'test/repro-postgres-prometheus-per-queue.test.ts',
      'test/repro-postgres-compat-job-past-run-time.test.ts',
      'test/postgres-fast-check-lifecycle.test.ts',
      'test/postgres-flow-legacy-repair-coverage.test.ts',
    ]) {
      expect(gated).toContain(file);
    }
    expect(gated).not.toContain('test/repro-compat-job-past-run-time.test.ts');
    expect(gated).not.toContain('test/sdk-conformance-harness-lifecycle.test.ts');
  });

  test('a gated file outside the runner rule is reported, also through a helper', () => {
    const sources = new Map([
      ['test/direct.test.ts', 'const url = Bun.env.BUNQUEUE_TEST_POSTGRES_URL;'],
      ['test/nested/helper.test.ts', "import { url } from '../support/pg';"],
      ['test/support/pg.ts', "export const url = process.env['BUNQUEUE_TEST_POSTGRES_URL'];"],
      ['test/mention.test.ts', "const names = ['BUNQUEUE_TEST_POSTGRES_URL'];"],
    ]);
    const selected = postgresRunnerSelection();
    const missing = postgresGatedTestFiles(sources).filter((file) => !selected.has(file));
    expect(missing).toEqual(['test/direct.test.ts', 'test/nested/helper.test.ts']);
  });

  test('the selection keeps every postgres-* file and adds every repro-postgres-* file', () => {
    const selected = postgresRunnerSelection();
    for (const pattern of ['test/postgres-*.test.ts', 'test/repro-postgres-*.test.ts']) {
      const files = [...new Bun.Glob(pattern).scanSync({ cwd: ROOT, onlyFiles: true })];
      expect(files.length).toBeGreaterThan(0);
      expect(files.filter((file) => !selected.has(file))).toEqual([]);
    }
  });
});
