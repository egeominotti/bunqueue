import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Diagrams and widgets (the queue simulator, the MCP and dashboard diagrams, the
// examples explorers) mark their root `.not-content`, as Starlight's own Markdown
// styles expect. The docs theme restyles headings, paragraphs, links, inline code and
// tables inside `.sl-markdown-content`; every such rule must skip `.not-content`, or a
// widget's panel titles turn into page headings (the simulator's lanes rendered as
// 2rem condensed headings after the theme refresh).

const STYLES = join(import.meta.dir, '..', 'docs', 'src', 'styles');
const FILES = ['docs-theme.css', 'docs-reading.css'];
const CONTENT_TARGET =
  /(^|[\s>+~(,])(h[1-6]|p|li|a|code|table|th|td|thead|ul|ol)\b|:is\((p|li|h[1-6])/;

/** Split a selector list on top-level commas (commas inside :is()/:not() stay). */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of list) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function contentSelectors(css: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors: string[] = [];
  for (const match of withoutComments.matchAll(/([^{}]+)\{/g)) {
    const prelude = match[1].trim();
    if (prelude.startsWith('@')) continue;
    for (const selector of splitSelectors(prelude)) {
      const scoped = selector.slice(selector.indexOf('.sl-markdown-content'));
      if (selector.includes('.sl-markdown-content') && CONTENT_TARGET.test(scoped)) {
        selectors.push(selector);
      }
    }
  }
  return selectors;
}

test('theme rules for Markdown content skip .not-content widgets', () => {
  const offenders: string[] = [];
  let checked = 0;
  for (const file of FILES) {
    for (const selector of contentSelectors(readFileSync(join(STYLES, file), 'utf8'))) {
      checked++;
      if (!selector.includes('not-content')) offenders.push(`${file}: ${selector}`);
    }
  }
  expect(checked).toBeGreaterThan(10);
  expect(offenders).toEqual([]);
});
