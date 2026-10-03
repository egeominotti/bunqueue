import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The README and the guides pin Docker images to the current release
// (`egeominotti/bunqueue:2.9.9`, `2.9.9-distroless`, ...). Every release bumps them
// by hand, and nothing failed when one was forgotten. Every pinned tag must name the
// version in package.json, so a release cannot ship docs that point at the last one.

const ROOT = join(import.meta.dir, '..');
const DOCS = 'docs/src/content/docs';
const VERSION = (
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

/** Files that pin an image today; each must keep at least one pinned tag. */
const PINNED = [
  'README.md',
  `${DOCS}/guide/deployment.mdx`,
  `${DOCS}/guide/env-vars.md`,
  `${DOCS}/guide/installation.mdx`,
  `${DOCS}/guide/server.md`,
];

const TAG_PATTERNS = [
  /bunqueue:(\d+\.\d+\.\d+)/g,
  /`(\d+\.\d+\.\d+)-(?:alpine|debian|slim|distroless)`/g,
  /Unsuffixed tags such as `(\d+\.\d+\.\d+)`/g,
];

function pinnedVersions(text: string): string[] {
  return TAG_PATTERNS.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1]));
}

/** Every docs page except the changelog, which records past releases on purpose. */
function docsPages(): string[] {
  const glob = new Bun.Glob('**/*.{md,mdx}');
  return [...glob.scanSync({ cwd: join(ROOT, DOCS) })]
    .filter((path) => path !== 'changelog.md')
    .map((path) => `${DOCS}/${path}`);
}

describe('Docker tags in the docs follow package.json', () => {
  test('the files that pin an image still pin one', () => {
    for (const file of PINNED) {
      expect({
        file,
        pinned: pinnedVersions(readFileSync(join(ROOT, file), 'utf8')).length > 0,
      }).toEqual({ file, pinned: true });
    }
  });

  test(`every pinned tag names ${VERSION}`, () => {
    const stale: string[] = [];
    for (const file of new Set(['README.md', ...docsPages()])) {
      for (const version of pinnedVersions(readFileSync(join(ROOT, file), 'utf8'))) {
        if (version !== VERSION) stale.push(`${file}: ${version}`);
      }
    }
    expect(stale).toEqual([]);
  });
});
