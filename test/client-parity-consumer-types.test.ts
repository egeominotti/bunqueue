import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dir, '..');
const sdk = resolve(root, 'sdk/typescript');

function consumerSource(specifier: string): string {
  return `
import { Queue, Worker, QueueEvents, FlowProducer, SandboxedWorker } from '${specifier}';
const options = { connection: { host: 'localhost', port: 6789 } };
const queue = new Queue<{ value: number }>('types', options);
const worker = new Worker<{ value: number }>('types', async job => {
  await job.updateProgress(10);
  return job.data.value;
}, options);
const events = new QueueEvents('types', options);
const flow = new FlowProducer(options);
const sandbox = new SandboxedWorker('types', { ...options, processor: '/processor.mjs' });
// @ts-expect-error The generated declarations must preserve payload type checking.
void queue.add('invalid', { value: 'wrong' });
// @ts-expect-error Bun globals must not leak into Node consumers.
void Bun.sleep(1);
void queue; void worker; void events; void flow; void sandbox;
`;
}

function compile(entry: string, options: ts.CompilerOptions) {
  const program = ts.createProgram([entry], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: ['node'],
    ...options,
  });
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .map(
      (diagnostic) =>
        `${diagnostic.code}: ${diagnostic.file?.fileName ?? ''} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`
    );
  // Bun declarations must never enter a Node consumer's program.
  const bunTypes = program
    .getSourceFiles()
    .map((file) => file.fileName)
    .filter((name) => /\/(bun-types|@types\/bun)\//.test(name));
  return { diagnostics, bunTypes };
}

describe('published client declarations', () => {
  test('compile for a strict NodeNext consumer without Bun types', () => {
    mkdirSync(resolve(root, 'artifacts'), { recursive: true });
    const directory = mkdtempSync(resolve(root, 'artifacts/client-consumer-types-'));
    const entry = resolve(directory, 'index.mts');
    try {
      writeFileSync(entry, consumerSource('../../sdk/typescript/dist/index.js'));
      expect(compile(entry, { skipLibCheck: false })).toEqual({ diagnostics: [], bunTypes: [] });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30000);

  test('the manifest and entry declarations carry no runtime type packages', () => {
    const manifest = JSON.parse(readFileSync(resolve(sdk, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['msgpackr']);
    // Node types stay the consumer's choice: at most a permissive optional peer.
    for (const name of Object.keys(manifest.peerDependencies ?? {}))
      expect(manifest.peerDependenciesMeta?.[name]?.optional).toBe(true);
    for (const entry of ['index.d.ts', 'legacy.d.ts'])
      expect(readFileSync(resolve(sdk, 'dist', entry), 'utf8')).not.toMatch(
        /bun-types|@types\/bun/
      );
  });

  // The pinned Node type versions are SDK devDependencies, so this runs after
  // `bun install` in sdk/typescript (CI test:parity and the SDK sandbox) and
  // skips in environments that only install the root package.
  for (const major of ['20', '22']) {
    const types = resolve(sdk, `node_modules/@types/node-${major}`);
    test.skipIf(!existsSync(types))(
      `the packed SDK type-checks with @types/node ${major} and no skipLibCheck`,
      async () => {
        // Outside the repository, so no ancestor node_modules can satisfy a leak.
        const directory = mkdtempSync(join(tmpdir(), `bunqueue-client-node${major}-`));
        try {
          const pack = Bun.spawnSync(
            [process.execPath, 'pm', 'pack', '--ignore-scripts', '--destination', directory],
            { cwd: sdk, stdout: 'pipe', stderr: 'pipe' }
          );
          expect(pack.exitCode).toBe(0);
          const archive = readdirSync(directory).find((name) => name.endsWith('.tgz'));
          const installed = resolve(directory, 'node_modules/bunqueue-client');
          mkdirSync(installed, { recursive: true });
          const untar = Bun.spawnSync(
            ['tar', '-xzf', resolve(directory, archive!), '-C', installed, '--strip-components=1'],
            { stdout: 'pipe', stderr: 'pipe' }
          );
          expect(untar.exitCode).toBe(0);
          mkdirSync(resolve(directory, 'node_modules/@types'), { recursive: true });
          symlinkSync(types, resolve(directory, 'node_modules/@types/node'), 'dir');
          writeFileSync(resolve(directory, 'package.json'), '{"type":"module"}\n');
          const entry = resolve(directory, 'index.mts');
          writeFileSync(entry, consumerSource('bunqueue-client'));
          const typeRoots = [resolve(directory, 'node_modules/@types')];
          // Default target libraries include DOM; Node presets such as
          // @tsconfig/node22 do not, so both must compile.
          for (const options of [
            { skipLibCheck: false },
            { skipLibCheck: false, lib: ['lib.es2022.d.ts'] },
            { skipLibCheck: true },
          ])
            expect(compile(entry, { ...options, typeRoots })).toEqual({
              diagnostics: [],
              bunTypes: [],
            });
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
      60000
    );
  }
});
