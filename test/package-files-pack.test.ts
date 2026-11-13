/**
 * The `files` field of package.json, as `bun pm pack` (what CI packs with) reads it.
 *
 * Bun 1.4.4 ignores a bare directory negation such as `!dist/benchmark`: with a
 * `dist/benchmark/` directory present it still packs the `.js` and `.d.ts` files in
 * it, while npm excludes them. The repository's real `files` list is packed here in
 * a temporary package whose `dist/` holds one published module and probe files under
 * `dist/benchmark/`, so a negation only npm honors fails this test.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const { files } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  files: string[];
};

let dir = '';

function write(path: string, content: string): void {
  const target = join(dir, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content);
}

function packedPaths(): string[] {
  const result = Bun.spawnSync([process.execPath, 'pm', 'pack', '--dry-run', '--ignore-scripts'], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  expect({ exitCode: result.exitCode, output }).toEqual({ exitCode: 0, output });
  return output
    .split('\n')
    .filter((line) => line.startsWith('packed '))
    .map((line) => line.trim().split(/\s+/).at(-1) ?? '')
    .sort();
}

describe('package.json files under bun pm pack', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'bunqueue-pack-files-'));
    write('package.json', JSON.stringify({ name: 'pack-probe', version: '0.0.0', files }));
    write('README.md', '# probe\n');
    write('dist/client/index.js', 'export {};\n');
    write('dist/client/index.d.ts', 'export {};\n');
    write('dist/benchmark/probe.js', 'export {};\n');
    write('dist/benchmark/probe.d.ts', 'export {};\n');
    write('dist/benchmark/nested/deep.js', 'export {};\n');
    write('dist/bunqueue', 'compiled binary placeholder');
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('packs the library modules and never dist/benchmark or the compiled binary', () => {
    const packed = packedPaths();
    expect(packed).toContain('dist/client/index.js');
    expect(packed).toContain('dist/client/index.d.ts');
    expect(packed).toContain('README.md');
    expect(packed.filter((path) => path.startsWith('dist/benchmark'))).toEqual([]);
    expect(packed).not.toContain('dist/bunqueue');
  });
});
