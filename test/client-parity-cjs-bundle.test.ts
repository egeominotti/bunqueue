/**
 * The published bunqueue-client output must stay consumable by CommonJS
 * bundlers (Lambda-style `--format=cjs --bundle`), which reject top-level
 * await, while embedded mode keeps loading the Bun-only engine lazily.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dir, '..');
const dist = resolve(root, 'sdk/typescript/dist');

/** Every `await` / `for await` that is not nested in a function body. */
function topLevelAwaits(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node)) return;
    if (
      ts.isAwaitExpression(node) ||
      (ts.isForOfStatement(node) && node.awaitModifier !== undefined)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push(
        `${file.slice(dist.length + 1)}:${line + 1}: ${node.getText(source).slice(0, 80)}`
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

async function run(command: string[], cwd = root) {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, BUNQUEUE_EMBEDDED: '0' },
    stdout: 'pipe',
    stderr: 'pipe',
    // A leaked engine timer would otherwise hold the probe open until the test timeout.
    timeout: 20000,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/**
 * Path of a real Node.js binary, or null. The Bun image ships
 * `/usr/local/bun-node-fallback-bin/node`, a shim that runs Bun, so a bare
 * `Bun.which('node')` would assert Node-only behavior against Bun.
 */
function realNode(): string | null {
  const node = Bun.which('node');
  if (!node) return null;
  try {
    const probe = Bun.spawnSync(
      [node, '-e', 'process.stdout.write(process.versions.bun ? "bun" : "node")'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    return probe.exitCode === 0 && probe.stdout.toString() === 'node' ? node : null;
  } catch {
    return null;
  }
}

// Loads the CommonJS re-bundle and reports what embedded mode does with it.
const CJS_PROBE = `
const sdk = require(process.argv.at(-1));
if (typeof sdk.Queue !== 'function' || typeof sdk.Worker !== 'function') throw new Error('missing exports');
let embedded = 'ok';
try {
  new sdk.Queue('cjs-probe', { embedded: true, dataPath: ':memory:' }).close();
} catch (error) {
  embedded = error.message;
} finally {
  sdk.shutdownManager();
}
console.log(JSON.stringify({ embedded }));
`;

describe('portable client bundle compatibility', () => {
  test('the built SDK contains no top-level await', () => {
    const files = readdirSync(dist).filter((name) => name.endsWith('.js'));
    expect(files).toContain('index.js');
    expect(files.flatMap((name) => topLevelAwaits(resolve(dist, name)))).toEqual([]);
  });

  test('a CommonJS re-bundle of the SDK builds and loads', async () => {
    mkdirSync(resolve(root, 'artifacts'), { recursive: true });
    // Inside the repository so the re-bundle resolves the external msgpackr.
    const directory = mkdtempSync(resolve(root, 'artifacts/client-cjs-bundle-'));
    try {
      const build = await Bun.build({
        entrypoints: [resolve(dist, 'index.js')],
        outdir: directory,
        naming: 'bundle.cjs',
        format: 'cjs',
        target: 'node',
        external: ['msgpackr'],
        throw: false,
      });
      expect(build.logs.filter((log) => log.level === 'error').map(String)).toEqual([]);
      expect(build.success).toBe(true);
      const bundle = resolve(directory, 'bundle.cjs');
      const runtimes = [process.execPath];
      // Real Node is optional on the root unit-test image; the SDK sandbox always has it.
      const node = realNode();
      if (node) runtimes.push(node);
      for (const runtime of runtimes) {
        const result = await run([runtime, '-e', CJS_PROBE, bundle]);
        expect({ runtime, exitCode: result.exitCode, stderr: result.stderr }).toEqual({
          runtime,
          exitCode: 0,
          stderr: '',
        });
        const { embedded } = JSON.parse(result.stdout.trim()) as { embedded: string };
        if (runtime === node) {
          // Node never evaluates the Bun engine, even from a re-bundle.
          expect(embedded).toBe(
            'Embedded mode requires Bun; use a TCP connection in this runtime.'
          );
        } else {
          // Bun either reaches the engine through the bundle-time location of
          // the published file or reports why the re-bundle cannot.
          expect(embedded === 'ok' || embedded.startsWith('Embedded mode could not load')).toBe(
            true
          );
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60000);

  test('embedded mode loads the Bun engine synchronously on first use', async () => {
    const client = resolve(dist, 'index.js');
    const result = await run([
      process.execPath,
      '--eval',
      `
      const { Queue, QueueGroup, shutdownManager } = await import(${JSON.stringify(client)});
      // TCP-only helpers must not need the engine before embedded mode is used.
      shutdownManager();
      const before = await new QueueGroup('lazy').listQueuesAsync();
      const queue = new Queue('lazy:jobs', { embedded: true, dataPath: ':memory:' });
      try {
        await queue.add('probe', { n: 1 });
        const after = await new QueueGroup('lazy').listQueuesAsync();
        console.log(JSON.stringify({ before, after, count: await queue.countAsync() }));
      } finally {
        queue.close();
        shutdownManager();
      }
      `,
    ]);
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
      exitCode: 0,
      stderr: '',
    });
    expect(JSON.parse(result.stdout.trim())).toEqual({ before: [], after: ['jobs'], count: 1 });
  }, 30000);
});
