import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import {
  BUN_CLI_SERVER,
  EMBEDDED_RUNTIME,
  SERVER_HEALTH_CHECK,
  SERVER_RUNTIMES,
  dockerRunCommand,
} from '../docs/src/data/firstJob';

const ROOT = join(import.meta.dir, '..');

// The "first job" examples live in docs/src/data/firstJob.ts and are rendered both by the
// homepage quickstart and by /guide/quickstart/. Every TypeScript file among them must
// compile against the public client APIs, exactly as a reader copies it. (The JavaScript
// ones read job.data without a type annotation, which is fine in JavaScript and would only
// produce false positives under checkJs.)
const runtimes = [...SERVER_RUNTIMES, EMBEDDED_RUNTIME];
const examples = runtimes.flatMap((runtime) =>
  runtime.files
    .filter((file) => file.lang === 'typescript')
    .map((file) => ({ runtime: runtime.id, ...file }))
);

test('every first-job runtime has an install command, its files and a run command', () => {
  expect(runtimes.map((runtime) => runtime.id)).toEqual([
    'node',
    'bun',
    'deno',
    'python',
    'php',
    'go',
    'rust',
    'elixir',
    'embedded',
  ]);
  for (const runtime of runtimes) {
    expect(runtime.install.trim()).not.toBe('');
    expect(runtime.run.trim()).not.toBe('');
    expect(runtime.files.length).toBeGreaterThan(0);
    for (const file of runtime.files) expect(file.code.trim()).not.toBe('');
  }
});

test('the README quickstart shows the same first-job examples as the docs', () => {
  // npm and GitHub readers start from the README: it must not drift from the tested files.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const node = SERVER_RUNTIMES.find((runtime) => runtime.id === 'node');
  if (!node) throw new Error('Missing the Node.js first-job example');
  for (const runtime of [EMBEDDED_RUNTIME, node]) {
    expect(readme).toContain(runtime.install);
    expect(readme).toContain(runtime.files[0].code);
    expect(readme).toContain(runtime.run);
  }
});

test('the bunqueue-client README quick start matches the tested Node.js example', () => {
  // The npm page of the client is many readers' first contact: same server commands and file.
  const readme = readFileSync(join(ROOT, 'sdk/typescript/README.md'), 'utf8');
  const node = SERVER_RUNTIMES.find((runtime) => runtime.id === 'node');
  if (!node) throw new Error('Missing the Node.js first-job example');
  for (const snippet of [
    dockerRunCommand(),
    BUN_CLI_SERVER,
    SERVER_HEALTH_CHECK,
    node.install,
    node.files[0].code,
    node.run,
  ]) {
    expect(readme).toContain(snippet);
  }
});

test('first-job TypeScript examples compile against the public client APIs', () => {
  expect(examples.map(({ runtime, name }) => `${runtime}:${name}`)).toEqual([
    'deno:jobs.ts',
    'embedded:jobs.ts',
  ]);

  // Keep each example in its own virtual module without writing generated files.
  const files = new Map(
    examples.map(({ runtime, code }) => [join(ROOT, `first-job-${runtime}.ts`), code])
  );
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: ['bun-types'],
    paths: {
      'bunqueue/client': [join(ROOT, 'src/client/index.ts')],
      'bunqueue-client': [join(ROOT, 'sdk/typescript/src/index.ts')],
    },
  };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const code = files.get(fileName);
    return code === undefined
      ? originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(fileName, code, languageVersion, true);
  };
  const program = ts.createProgram([...files.keys()], options, host);
  expect(program.getOptionsDiagnostics()).toEqual([]);

  const errors = [...files.keys()].flatMap((fileName) => {
    const file = program.getSourceFile(fileName);
    if (!file) throw new Error(`Missing compiled example: ${fileName}`);
    const diagnostics = [
      ...program.getSyntacticDiagnostics(file),
      ...program.getSemanticDiagnostics(file),
    ];
    return diagnostics.map((diagnostic) => {
      const position = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
      return `${fileName}:${position.line + 1} TS${diagnostic.code}: ${message}`;
    });
  });
  expect(errors).toEqual([]);
}, 30_000);
