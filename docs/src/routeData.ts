import { defineRouteMiddleware } from '@astrojs/starlight/route-data';

/**
 * Starlight appends " | bunqueue" to every <title>. Titles that already name the
 * project would carry the brand twice, so they keep the page title on its own.
 */
export const onRequest = defineRouteMiddleware((context) => {
  const { entry, head } = context.locals.starlightRoute;
  if (!/bunqueue/i.test(entry.data.title)) return;
  const title = head.find((tag) => tag.tag === 'title');
  if (title) title.content = entry.data.title;
});
