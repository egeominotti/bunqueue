import { defineCollection } from 'astro:content';
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  // Starlight always queries an `i18n` collection for UI-string overrides.
  // Under Astro 7 a missing collection logs "The collection "i18n" does not
  // exist or is empty" on every build (Starlight's console.warn silencing no
  // longer reaches Astro's logger). `src/content/i18n/en.json` is an empty
  // override, so the built-in English UI strings are unchanged.
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
