import type { APIRoute } from 'astro';
import { blogFeed } from '../../lib/feed';

/** Release posts only: one item per bunqueue version. */
export const GET: APIRoute = () =>
  blogFeed({
    releasesOnly: true,
    title: 'bunqueue releases',
    description: 'One post per bunqueue release: what changed, how to install it and who contributed.',
    path: '/blog/releases.xml',
  });
