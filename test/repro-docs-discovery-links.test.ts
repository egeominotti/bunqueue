import { afterEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const fixtures: string[] = [];
const site = 'https://bunqueue.dev';
const hub = `${site}/examples/postgres-multibroker/`;
const routes = [
  '',
  'examples/postgres-multibroker/',
  'examples/postgres-multibroker/docker/',
  'examples/postgres-multibroker/queues-workers/',
  'examples/postgres-multibroker/reliability/',
  'examples/postgres-multibroker/flows/',
  'examples/postgres-multibroker/operations/',
  'examples/postgres-multibroker/validation/',
];

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, path: string, body: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'bq-discovery-links-'));
  fixtures.push(root);
  // Execute the repository's validator and its real dependencies without Astro or dist.
  for (const file of [
    'scripts/validate-discovery.ts',
    'src/lib/llms-full.ts',
    'src/lib/reference-seo.ts',
    'src/data/firstJob.ts',
    'src/data/apiVersions.json',
  ]) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(new URL(`../docs/${file}`, import.meta.url), target);
  }
  const { current } = JSON.parse(readFileSync(join(root, 'src/data/apiVersions.json'), 'utf8'));
  for (const route of routes) {
    write(root, `src/content/docs/${route}index.md`, '# Fixture page\n');
    write(
      root,
      `dist/${route}index.html`,
      `<head><title>Fixture</title><meta name="description" content="Fixture page">` +
        `<link rel="canonical" href="${site}/${route}"></head>`
    );
  }
  write(root, `public/reference/${current}/index.html`, '<head></head>');
  write(
    root,
    `dist/reference/${current}/index.html`,
    '<head><title>Fixture API</title><meta name="description" content="Fixture API reference">' +
      `<link rel="canonical" href="${site}/reference/${current}/">` +
      '<meta name="robots" content="noindex, follow"></head>'
  );
  write(
    root,
    'dist/llms-full.txt',
    routes.map((route) => `# Fixture\nURL: ${site}/${route}\n\nFixture body`).join('\n\n---\n\n')
  );
  write(
    root,
    'public/llms.txt',
    `[Full documentation](${site}/llms-full.txt)\n[PostgreSQL Multi-Broker Example](${hub})\n`
  );
  write(
    root,
    'public/robots.txt',
    `Sitemap: ${site}/sitemap-index.xml\n${site}/llms.txt\n${site}/llms-full.txt\n`
  );
  write(
    root,
    'dist/sitemap-0.xml',
    '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
      routes.map((route) => `<url><loc>${site}/${route}</loc></url>`).join('') +
      '</urlset>'
  );
  write(
    root,
    'dist/sitemap-index.xml',
    `<sitemapindex><sitemap><loc>${site}/sitemap-0.xml</loc></sitemap></sitemapindex>`
  );
  write(root, 'vercel.json', '{"headers":[]}');
  return root;
}

async function validate(root: string) {
  const child = Bun.spawn([process.execPath, join(root, 'scripts/validate-discovery.ts')], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe('curated discovery links', () => {
  test('accepts the exact full-text URL after validating its generated resource', async () => {
    const result = await validate(fixture());
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Discovery outputs OK: 8 full-text pages, 8 sitemap URLs');
  });

  test.each([
    `${site}/unknown.txt`,
    `${site}/llms-full.txt/`,
    `${site}/llms-full.txt?download=1`,
    `${site}/examples/postgres-multibroker`,
    `${site}/examples/postgres-multibroker/?view=all`,
  ])('rejects a non-canonical curated link: %s', async (url) => {
    const root = fixture();
    const path = 'public/llms.txt';
    write(root, path, `${readFileSync(join(root, path), 'utf8')}[Invalid](${url})\n`);
    const result = await validate(root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`llms.txt links to non-canonical page ${url}`);
    expect(result.stderr).toContain('Discovery validation failed (1)');
  });

  test('rejects an incomplete full-text resource even when its URL is curated', async () => {
    const root = fixture();
    const path = 'dist/llms-full.txt';
    write(root, path, readFileSync(join(root, path), 'utf8').replace(`URL: ${site}/\n`, ''));
    const result = await validate(root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`llms-full.txt is missing ${site}/`);
    expect(result.stderr).toContain('Discovery validation failed (1)');
  });

  test('rejects unresolved executable content in a curated full-text resource', async () => {
    const root = fixture();
    const path = 'dist/llms-full.txt';
    write(root, path, `${readFileSync(join(root, path), 'utf8')}\n<Code code={source} />\n`);
    const result = await validate(root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('llms-full.txt contains an unresolved executable-example');
    expect(result.stderr).toContain('Discovery validation failed (1)');
  });

  test('rejects a missing full-text resource even when its URL is curated', async () => {
    const root = fixture();
    rmSync(join(root, 'dist/llms-full.txt'));
    const result = await validate(root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ENOENT');
    expect(result.stderr).toContain('llms-full.txt');
  });
});
