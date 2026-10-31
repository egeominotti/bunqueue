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

test('no TypeScript file switches type checking off inline', async () => {
  // The nocheck directive silences a whole file and the ignore directive a line, without a
  // trace in tsconfig. The files are read from disk (not with git: the sandbox images and
  // Machine snapshots have no .git), and the directives are built from fragments so this
  // test does not match itself.
  const directives = ['@ts-' + 'nocheck', '@ts-' + 'ignore'];
  const skip = /(^|\/)(node_modules|dist|dist-test|artifacts|\.claude|\.git)\//;
  const roots = [
    'src',
    'test',
    'scripts',
    'bench',
    'examples',
    'sdk/conformance',
    'sdk/typescript/src',
    'sdk/typescript/tests',
    'docs/src',
  ];
  const glob = new Bun.Glob('**/*.{ts,tsx,mts,cts}');
  const found: string[] = [];
  let scanned = 0;
  for (const root of roots) {
    for await (const file of glob.scan({ cwd: join(ROOT, root), dot: false })) {
      if (skip.test(`${root}/${file}`)) continue;
      scanned++;
      const text = await Bun.file(join(ROOT, root, file)).text();
      for (const directive of directives)
        if (text.includes(directive)) found.push(`${root}/${file}: ${directive}`);
    }
  }
  // A scan that read nothing would pass vacuously.
  expect(scanned).toBeGreaterThan(1000);
  expect(found).toEqual([]);
});
