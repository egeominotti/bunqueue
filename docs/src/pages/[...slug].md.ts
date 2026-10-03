import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import { inlineFirstJobCode } from '../lib/llms-full';

/**
 * Raw markdown-source twin of every doc page, served at `/<slug>.md`, for AI
 * crawlers and agents that prefer the source over rendered HTML+nav (GEO). The
 * body is the page's authored markdown/MDX verbatim (imports and JSX included
 * on .mdx pages), except that the shared first-job examples (FirstJobCode and the
 * server commands from src/data/firstJob.ts) are expanded into code fences, since a
 * reader copying the page needs the code itself. Companion to /llms.txt (curated
 * index) and /llms-full.txt.
 */
const SITE = 'https://bunqueue.dev';

export const getStaticPaths: GetStaticPaths = async () => {
  const docs = await getCollection('docs');
  return docs
    .filter((e) => e.id !== '404')
    .map((e) => ({ params: { slug: e.id }, props: { entry: e } }));
};

export const GET: APIRoute = async ({ props }) => {
  const e = (props as { entry: Awaited<ReturnType<typeof getCollection>>[number] }).entry;
  const url = e.id === 'index' || e.id === '' ? `${SITE}/` : `${SITE}/${e.id}/`;
  const front =
    `# ${e.data.title}\n\n` +
    (e.data.description ? `${e.data.description}\n\n` : '') +
    `Canonical: ${url}\n\n---\n\n`;
  return new Response(front + inlineFirstJobCode(e.body ?? ''), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
