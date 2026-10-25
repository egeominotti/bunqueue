/**
 * Turns every dated changelog release into a blog post, in the shape of Bun's
 * release posts: title "bunqueue vX.Y.Z", a one-line summary, install and
 * upgrade commands, one section per new feature, the remaining changes with
 * bugfixes last, and the contributors. The changelog is the source of the
 * draft. A release post is then rewritten by hand into a professional article:
 * removing the generated marker hands the file over, and the generator never
 * touches it again (--check only requires that it exists).
 *
 *   bun docs/scripts/generate-release-posts.ts           write the posts
 *   bun docs/scripts/generate-release-posts.ts --check   exit 1 if a post is stale
 *   bun docs/scripts/generate-release-posts.ts --refresh refresh release metadata
 *                                                        (GitHub, npm, Docker; needs gh)
 *
 * Release metadata (contributors, author, which tags, GitHub releases, npm
 * versions and Docker images exist) lives in src/data/releaseMeta.json so the
 * posts build offline and deterministically. Run --refresh during a release,
 * after the version is tagged and published, then regenerate.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DOCS_ROOT = join(import.meta.dir, '..');
const CHANGELOG = join(DOCS_ROOT, 'src/content/docs/changelog.md');
const BLOG = join(DOCS_ROOT, 'src/content/docs/blog');
const META = join(DOCS_ROOT, 'src/data/releaseMeta.json');
const SITE = 'https://bunqueue.dev';
const REPO = 'egeominotti/bunqueue';
const GENERATED = '<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->';

type Section = { title: string; lines: string[] };
type Release = { version: string; date: string; note: string | null; intro: string[]; sections: Section[] };
type VersionMeta = {
  tag?: boolean;
  release?: boolean;
  npm?: boolean;
  docker?: boolean;
  author?: string;
  contributors?: string[];
  previousTag?: string;
};
type Meta = { versions: Record<string, VersionMeta> };

const RELEASE_HEADING = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})(?:\s+\((.+)\))?\s*$/;
const FENCE = /^\s*(```|~~~)/;

export const postSlug = (version: string) => `bunqueue-v${version.replaceAll('.', '-')}`;

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export function parseChangelog(text: string): Release[] {
  const releases: Release[] = [];
  let current: Release | null = null;
  let section: Section | null = null;
  let inFence = false;
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    if (!inFence && line.startsWith('## ')) {
      const match = RELEASE_HEADING.exec(line);
      current = match
        ? { version: match[1], date: match[2], note: match[3] ?? null, intro: [], sections: [] }
        : null;
      if (current) releases.push(current);
      section = null;
      continue;
    }
    if (!current) continue;
    if (!inFence && line.startsWith('### ')) {
      section = { title: line.slice(4).trim(), lines: [] };
      current.sections.push(section);
      continue;
    }
    (section ? section.lines : current.intro).push(line);
  }
  return releases;
}

const trimBlank = (lines: string[]) => {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end);
};

/** Changelog sections use ### and ####; in a post they become ## and ###. */
function promoteHeadings(lines: string[]): string[] {
  let inFence = false;
  return lines.map((line) => {
    if (FENCE.test(line)) inFence = !inFence;
    return !inFence && /^#{4,6} /.test(line) ? line.slice(1) : line;
  });
}

type Item = { lines: string[] };

/** Splits a section into top-level list items and the content outside them. */
function splitItems(lines: string[]): { items: Item[]; rest: string[] } {
  const items: Item[] = [];
  const rest: string[] = [];
  let item: Item | null = null;
  let inFence = false;
  for (const line of lines) {
    const fence = FENCE.test(line);
    if (!inFence && /^[-*] /.test(line)) {
      item = { lines: [line] };
      items.push(item);
    } else if (item && (inFence || !line.trim() || /^\s/.test(line))) {
      item.lines.push(line);
    } else {
      item = null;
      rest.push(line);
    }
    if (fence) inFence = !inFence;
  }
  for (const it of items) it.lines = trimBlank(it.lines);
  return { items, rest: trimBlank(rest) };
}

const BOLD_LEAD = /^[-*] \*\*(.+?)\*\*\s*[:.—-]?\s*(.*)$/;

function featureTitle(item: Item): string | null {
  const match = BOLD_LEAD.exec(item.lines[0]);
  if (!match) return null;
  const title = match[1].replace(/[:.]\s*$/, '').trim();
  return title.length > 0 && title.length <= 90 ? title : null;
}

const dedent = (lines: string[]) => lines.map((line) => line.replace(/^ {2}/, ''));

/** "- **Title:** text" becomes "## Title" followed by the text, like Bun's feature sections. */
function featureSection(item: Item, title: string): string[] {
  const match = BOLD_LEAD.exec(item.lines[0]);
  const first = match?.[2] ?? '';
  const body = trimBlank([first, ...dedent(item.lines.slice(1))]);
  if (body.length) body[0] = body[0].replace(/^[a-z]/, (c) => c.toUpperCase());
  return [`## ${title}`, '', ...body];
}

type Kind = { rank: number; title: string; features?: boolean; fixes?: boolean };

function classify(rawTitle: string): Kind {
  const title = rawTitle.replace(/\s+/g, ' ').trim();
  const t = title.toLowerCase();
  if (/breaking|behavior changes|upgrade notes|migration|removed|deprecat/.test(t))
    return { rank: 0, title };
  if (/compatibility/.test(t)) return { rank: 3, title };
  if (/^(added|new|features?|release highlights|highlights)\b/.test(t)) return { rank: 1, title: "What's new", features: true };
  if (/^performance\b/.test(t)) return { rank: 2, title: 'Performance' };
  if (/^changed\b/.test(t)) return { rank: 3, title: 'Changes' };
  if (/^security\b/.test(t)) return { rank: 5, title: 'Security' };
  if (/^fixed\b|^fixes\b/.test(t)) return { rank: 6, title: 'Bugfixes', fixes: true };
  if (/\bfixes$/.test(t)) return { rank: 6, title, fixes: true };
  if (/^docs$/.test(t)) return { rank: 7, title: 'Documentation' };
  if (/test|ci\/cd|^ci\b|documentation|internal|^notes$|investigated/.test(t)) return { rank: 7, title };
  return { rank: 4, title };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function plainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:.\s]+$/, '')}…`;
}

function firstSentence(lines: string[]): string {
  const text = plainText(
    trimBlank(lines)
      .map((line) => line.replace(/^\s*(?:>\s*|#+\s+)/, ''))
      .join(' ')
  );
  const match = /^(.+?[.!?])(\s|$)/.exec(text);
  return match ? match[1] : text;
}

function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

function summarize(release: Release): string {
  let fixes = 0;
  let perf = 0;
  let additions = 0;
  const highlights: string[] = [];
  for (const section of release.sections) {
    const kind = classify(section.title);
    const { items } = splitItems(section.lines);
    if (kind.fixes) fixes += items.length;
    else if (kind.rank === 2) perf += items.length;
    else if (kind.features) {
      additions += items.length;
      for (const item of items) {
        const title = featureTitle(item);
        if (title) highlights.push(plainText(title));
      }
      if (!highlights.length) {
        for (const item of items) {
          const text = plainText(item.lines.join(' ').replace(/^[-*] /, '')).replace(/\.$/, '');
          if (text.length <= 70) highlights.push(text);
        }
      }
    }
  }
  const counts: string[] = [];
  const shipped: string[] = [];
  if (perf) shipped.push(plural(perf, 'performance improvement'));
  if (additions && !highlights.length) shipped.push(plural(additions, 'addition'));
  let lead = '';
  if (fixes) lead = `Fixes ${plural(fixes, 'bug')}${shipped.length ? ` and ships ${shipped.join(' and ')}` : ''}.`;
  else if (shipped.length) lead = `Ships ${shipped.join(' and ')}.`;
  let detail = '';
  if (highlights.length) {
    const shown = highlights.slice(0, 4).map((h, i) => (i === 0 ? h : lowerFirst(h)));
    detail = `${shown.join(', ')}${highlights.length > 4 ? ' and more' : ''}.`;
  } else if (trimBlank(release.intro).length) {
    detail = firstSentence(release.intro);
  } else {
    const first = release.sections.flatMap((s) => splitItems(s.lines).items)[0];
    detail = first ? firstSentence(first.lines.map((l) => l.replace(/^[-*] /, ''))) : '';
  }
  const summary = [lead, detail].filter(Boolean).join(' ');
  return truncate(summary || `bunqueue ${release.version} release notes.`, 240);
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderBody(release: Release): string[] {
  const kinds = release.sections.map((section, index) => ({ section, index, kind: classify(section.title) }));
  kinds.sort((a, b) => a.kind.rank - b.kind.rank || a.index - b.index);
  const out: string[] = [];
  for (const { section, kind } of kinds) {
    const lines = promoteHeadings(trimBlank(section.lines));
    if (!lines.length) continue;
    if (kind.features) {
      const { items, rest } = splitItems(lines);
      const plain: Item[] = [];
      if (rest.length) out.push(`## ${kind.title}`, '', ...rest, '');
      for (const item of items) {
        const title = featureTitle(item);
        if (title) out.push(...featureSection(item, title), '');
        else plain.push(item);
      }
      if (plain.length) {
        out.push(`## ${items.length === plain.length && !rest.length ? kind.title : 'More additions'}`, '');
        for (const item of plain) out.push(...item.lines);
        out.push('');
      }
      continue;
    }
    out.push(`## ${kind.title}`, '', ...lines, '');
  }
  return out;
}

function renderPost(release: Release, meta: VersionMeta, previous: Release | undefined): string {
  const slug = postSlug(release.version);
  const summary = summarize(release);
  const v = release.version;
  const yaml = (value: string) => JSON.stringify(value);
  const out: string[] = [
    '---',
    `title: ${yaml(`bunqueue v${v}`)}`,
    `description: ${yaml(summary)}`,
    'head:',
    '  - tag: meta',
    '    attrs:',
    '      property: og:image',
    `      content: ${SITE}/og/blog/${slug}.png`,
    '  - tag: meta',
    '    attrs:',
    '      property: og:type',
    '      content: article',
    '  - tag: meta',
    '    attrs:',
    '      property: article:published_time',
    `      content: ${yaml(release.date)}`,
    '---',
    '',
    GENERATED,
    '',
    '<div class="bq-wrap bq-hero">',
    '  <span class="bq-eyebrow">blog · release</span>',
    `  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v${v}</em></h1>`,
    `  <p class="bq-hero-sub">${escapeHtml(summary)}</p>`,
    '</div>',
    '',
  ];
  if (meta.author) {
    out.push(
      `<p class="bq-release-byline"><img src="https://github.com/${meta.author}.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/${meta.author}">${meta.author}</a></p>`,
      ''
    );
  }
  if (release.note) {
    out.push(
      ':::caution',
      `The changelog marks this release as "${release.note}". Install a later version instead.`,
      ':::',
      ''
    );
  }
  const intro = trimBlank(release.intro);
  if (intro.length) out.push(...intro, '');
  if (meta.npm || meta.docker) {
    out.push(`#### To install bunqueue v${v}`, '');
    if (meta.npm) {
      out.push('```bash title="bun"', `bun add bunqueue@${v}`, '```', '');
      out.push('```bash title="npm"', `npm install bunqueue@${v}`, '```', '');
    }
    if (meta.docker) {
      out.push(
        '```bash title="docker"',
        // The tag goes through a variable: test/docs-docker-tags-version.test.ts
        // requires every literal image tag in the docs to name the current version.
        `TAG=${v}`,
        `docker run -p 6789:6789 -p 6790:6790 ghcr.io/${REPO}:$TAG`,
        '```',
        ''
      );
    }
    out.push('#### To upgrade bunqueue', '', '```bash', 'bun add bunqueue@latest', '```', '');
  }
  out.push(...renderBody(release));
  const contributors = meta.contributors ?? [];
  if (contributors.length) {
    out.push(`## Thanks to ${plural(contributors.length, 'contributor')}!`, '');
    for (const login of contributors) out.push(`- [@${login}](https://github.com/${login})`);
    out.push('');
  }
  const links: string[] = [];
  if (meta.release) links.push(`[Release on GitHub](https://github.com/${REPO}/releases/tag/v${v})`);
  if (meta.tag && meta.previousTag)
    links.push(`[Commits since ${meta.previousTag}](https://github.com/${REPO}/compare/${meta.previousTag}...v${v})`);
  links.push('[Full changelog](/changelog/)', '[All posts](/blog/)');
  if (previous) links.unshift(`[← bunqueue v${previous.version}](/blog/${postSlug(previous.version)}/)`);
  out.push('---', '', links.join(' · '), '');
  return out.join('\n');
}

function readMeta(): Meta {
  return existsSync(META) ? (JSON.parse(readFileSync(META, 'utf8')) as Meta) : { versions: {} };
}

function expectedPosts(): Map<string, string> {
  const releases = parseChangelog(readFileSync(CHANGELOG, 'utf8'));
  const meta = readMeta();
  const posts = new Map<string, string>();
  const ordered = [...releases].sort((a, b) => compareVersions(b.version, a.version));
  ordered.forEach((release, index) => {
    const post = renderPost(release, meta.versions[release.version] ?? {}, ordered[index + 1]);
    posts.set(`${postSlug(release.version)}.md`, post);
  });
  return posts;
}

/** A release post without the generated marker was rewritten by hand and is left alone. */
const isHandWritten = (file: string) =>
  existsSync(join(BLOG, file)) && !readFileSync(join(BLOG, file), 'utf8').includes(GENERATED);

const isGeneratedPost = (file: string) =>
  /^bunqueue-v\d+-\d+-\d+\.md$/.test(file) && readFileSync(join(BLOG, file), 'utf8').includes(GENERATED);

function write(): void {
  const posts = expectedPosts();
  let changed = 0;
  let handWritten = 0;
  for (const file of readdirSync(BLOG)) {
    if (isGeneratedPost(file) && !posts.has(file)) {
      rmSync(join(BLOG, file));
      changed++;
    }
  }
  for (const [file, content] of posts) {
    const path = join(BLOG, file);
    if (isHandWritten(file)) {
      handWritten++;
      continue;
    }
    if (existsSync(path) && readFileSync(path, 'utf8') === content) continue;
    writeFileSync(path, content);
    changed++;
  }
  console.log(
    `release posts: ${posts.size} posts (${handWritten} hand-written), ${changed} written or removed`
  );
}

function check(): void {
  const posts = expectedPosts();
  const problems: string[] = [];
  for (const [file, content] of posts) {
    const path = join(BLOG, file);
    if (!existsSync(path)) problems.push(`missing ${file}`);
    else if (!isHandWritten(file) && readFileSync(path, 'utf8') !== content)
      problems.push(`stale ${file}`);
  }
  for (const file of readdirSync(BLOG)) {
    if (isGeneratedPost(file) && !posts.has(file)) problems.push(`orphaned ${file}`);
  }
  if (problems.length) {
    console.error(
      `release posts are out of date with the changelog (${problems.length}):\n  ${problems.slice(0, 20).join('\n  ')}\n` +
        'Run: bun docs/scripts/generate-release-posts.ts'
    );
    process.exit(1);
  }
  console.log(`release posts OK: ${posts.size} posts match the changelog`);
}

// ── --refresh: release metadata from GitHub, npm and Docker Hub ──────────

async function gh(args: string[]): Promise<string> {
  const proc = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`gh ${args.join(' ')} failed: ${err.trim()}`);
  return out;
}

const BOT = /\[bot\]$|^(claude|copilot|github-actions|dependabot)$/i;
const NOREPLY = /^(?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$/i;

type CompareCommit = {
  author: { login: string } | null;
  commit: { message: string; author: { email: string } };
};

async function contributorsBetween(previous: string, tag: string) {
  const json = await gh(['api', `repos/${REPO}/compare/${previous}...${tag}?per_page=250`]);
  const commits = (JSON.parse(json) as { commits: CompareCommit[] }).commits;
  const logins = new Set<string>();
  for (const c of commits) {
    const login = c.author?.login ?? NOREPLY.exec(c.commit.author.email)?.[1];
    if (login) logins.add(login);
    for (const match of c.commit.message.matchAll(/^Co-authored-by:.*<([^>]+)>\s*$/gim)) {
      const coauthor = NOREPLY.exec(match[1])?.[1];
      if (coauthor) logins.add(coauthor);
    }
  }
  const last = commits.at(-1);
  const author = last?.author?.login ?? (last ? NOREPLY.exec(last.commit.author.email)?.[1] : undefined);
  const contributors = [...logins]
    .filter((login) => !BOT.test(login))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return { author: author && !BOT.test(author) ? author : undefined, contributors };
}

async function dockerTags(): Promise<Set<string>> {
  const tags = new Set<string>();
  let url: string | null = 'https://hub.docker.com/v2/repositories/egeominotti/bunqueue/tags?page_size=100';
  while (url) {
    const page = (await (await fetch(url)).json()) as { next: string | null; results: { name: string }[] };
    for (const t of page.results) tags.add(t.name);
    url = page.next;
  }
  return tags;
}

async function refresh(): Promise<void> {
  const releases = parseChangelog(readFileSync(CHANGELOG, 'utf8'));
  const versions = releases.map((r) => r.version).sort(compareVersions);
  const tags = new Set(
    (await gh(['api', '--paginate', `repos/${REPO}/tags?per_page=100`, '--jq', '.[].name']))
      .split('\n')
      .filter(Boolean)
  );
  const releaseTags = new Set(
    (await gh(['release', 'list', '-R', REPO, '--limit', '1000', '--json', 'tagName', '--jq', '.[].tagName']))
      .split('\n')
      .filter(Boolean)
  );
  const npm = (await (await fetch('https://registry.npmjs.org/bunqueue')).json()) as {
    versions: Record<string, unknown>;
  };
  const docker = await dockerTags();
  const meta: Meta = { versions: {} };
  const tagged = versions.filter((v) => tags.has(`v${v}`));
  const jobs: Promise<void>[] = [];
  let running = 0;
  const queue: (() => Promise<void>)[] = [];
  const run = async (job: () => Promise<void>) => {
    while (running >= 8) await new Promise<void>((resolve) => queue.push(async () => resolve()));
    running++;
    try {
      await job();
    } finally {
      running--;
      queue.shift()?.();
    }
  };
  for (const v of versions) {
    const entry: VersionMeta = {
      tag: tags.has(`v${v}`),
      release: releaseTags.has(`v${v}`),
      npm: v in npm.versions,
      docker: docker.has(v),
    };
    meta.versions[v] = entry;
    const position = tagged.indexOf(v);
    if (position > 0) {
      const previous = `v${tagged[position - 1]}`;
      entry.previousTag = previous;
      jobs.push(
        run(async () => {
          const { author, contributors } = await contributorsBetween(previous, `v${v}`);
          if (author) entry.author = author;
          if (contributors.length) entry.contributors = contributors;
        })
      );
    }
  }
  await Promise.all(jobs);
  const ordered: Meta = { versions: {} };
  for (const v of [...versions].reverse()) {
    ordered.versions[v] = Object.fromEntries(
      Object.entries(meta.versions[v]).filter(([, value]) => value !== false)
    ) as VersionMeta;
  }
  writeFileSync(META, `${JSON.stringify(ordered, null, 2)}\n`);
  console.log(`release metadata: ${versions.length} versions, ${tagged.length} tagged`);
}

if (import.meta.main) {
  const args = new Set(process.argv.slice(2));
  if (args.has('--refresh')) await refresh();
  if (args.has('--check')) check();
  else write();
}
