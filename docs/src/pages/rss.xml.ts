import type { APIRoute } from 'astro';
import { blogFeed } from '../lib/feed';

/** Every blog post: release notes and articles. */
export const GET: APIRoute = () =>
  blogFeed({
    title: 'bunqueue blog',
    description:
      'Release notes for every bunqueue version, plus guides, benchmarks and architecture deep dives on the job queue for Bun.',
    path: '/rss.xml',
  });
