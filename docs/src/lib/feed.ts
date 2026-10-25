import { getCollection } from 'astro:content';

/**
 * RSS 2.0 feeds of the blog: every post (/rss.xml) and the release posts only
 * (/blog/releases.xml). Items carry a category (Release, or the article's topic),
 * the post author when known, and are ordered newest first; posts published the same
 * day are ordered by version, so a feed reader lists 2.9.10 above 2.9.9.
 */
const SITE = 'https://bunqueue.dev';
const RELEASE_ID = /^blog\/bunqueue-v(\d+)-(\d+)-(\d+)$/;

type FeedOptions = {
  /** Keep only release posts. */
  releasesOnly?: boolean;
  title: string;
  description: string;
  /** Path of this feed, for the atom:link self reference. */
  path: string;
};

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function headContent(entry: any, property: string): string | undefined {
  for (const h of entry.data.head ?? []) {
    if (h.attrs?.property === property) return h.attrs.content;
  }
  return undefined;
}

export async function blogFeed({ releasesOnly, title, description, path }: FeedOptions) {
  const entries = await getCollection(
    'docs',
    (e: any) => e.id.startsWith('blog/') && e.id !== 'blog' && (!releasesOnly || RELEASE_ID.test(e.id))
  );

  const items = entries
    .map((e: any) => {
      const body = String(e.body ?? '');
      const version = RELEASE_ID.exec(e.id)?.slice(1).map(Number) ?? [];
      const topic = /bq-eyebrow">blog(?:\s*·\s*([^<]+))?</.exec(body)?.[1]?.trim();
      const author = /bq-release-byline">.*?href="https:\/\/github\.com\/([A-Za-z0-9-]+)"/.exec(body)?.[1];
      return {
        title: String(e.data.title).replace(/^"|"$/g, ''),
        description: String(e.data.description ?? ''),
        link: `${SITE}/${e.id}/`,
        date: headContent(e, 'article:published_time'),
        category: version.length ? 'Release' : topic ? topic[0].toUpperCase() + topic.slice(1) : 'Article',
        author,
        version,
      };
    })
    .sort(
      (a, b) =>
        new Date(b.date ?? 0).getTime() - new Date(a.date ?? 0).getTime() ||
        (b.version[0] ?? 0) - (a.version[0] ?? 0) ||
        (b.version[1] ?? 0) - (a.version[1] ?? 0) ||
        (b.version[2] ?? 0) - (a.version[2] ?? 0)
    );

  // The newest post date, not the build time: a rebuild without new posts changes nothing.
  const newest = items.find((i) => i.date)?.date;
  const xmlItems = items
    .map(
      (i) => `    <item>
      <title>${escapeXml(i.title)}</title>
      <link>${escapeXml(i.link)}</link>
      <guid isPermaLink="true">${escapeXml(i.link)}</guid>
      ${i.date ? `<pubDate>${new Date(i.date).toUTCString()}</pubDate>` : ''}
      <category>${escapeXml(i.category)}</category>
      ${i.author ? `<dc:creator>${escapeXml(i.author)}</dc:creator>` : ''}
      <description>${escapeXml(i.description)}</description>
    </item>`
    )
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${SITE}/blog/</link>
    <atom:link href="${SITE}${path}" rel="self" type="application/rss+xml"/>
    <description>${escapeXml(description)}</description>
    <language>en</language>
    ${newest ? `<lastBuildDate>${new Date(newest).toUTCString()}</lastBuildDate>` : ''}
    <image>
      <url>${SITE}/og/blog.png</url>
      <title>${escapeXml(title)}</title>
      <link>${SITE}/blog/</link>
    </image>
${xmlItems}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
}
