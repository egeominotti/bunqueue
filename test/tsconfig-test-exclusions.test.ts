/**
 * `bun run typecheck` type-checks the whole test tree through `tsconfig.test.json`.
 * Every test file is covered: excluding one, or weakening the project's compiler
 * options, would silently hide its type errors. Fix the error instead.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dir, '..');
const CONFIG = join(ROOT, 'tsconfig.test.json');

/** Parsed with TypeScript's own JSONC reader, so comments and formatting cannot fool it. */
function config(): Record<string, unknown> {
  const parsed = ts.parseConfigFileTextToJson(CONFIG, readFileSync(CONFIG, 'utf8'));
  if (parsed.error)
    throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
  return parsed.config as Record<string, unknown>;
}

test('the test project includes every source and test file', () => {
  expect(config().include).toEqual(['src/**/*', 'test/**/*']);
});

test('no test file is excluded from type checking', () => {
  expect(config().exclude).toEqual(['node_modules', 'dist']);
  expect(config().files).toBeUndefined();
});

test('the test project does not weaken the checks it inherits', () => {
  // Only output settings may differ from tsconfig.json; anything else (noCheck,
  // strict: false, skipLibCheck, ...) could turn checking off without a visible error.
  expect(config().compilerOptions).toEqual({
    rootDir: '.',
    outDir: './dist-test',
    declaration: false,
    declarationMap: false,
    noEmit: true,
  });
  expect(config().extends).toBe('./tsconfig.json');
});

test('bun run typecheck runs the test project, not only src', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  expect(pkg.scripts.typecheck).toContain('bun check --no-script -p tsconfig.test.json');
});
