/**
 * Turns an MDX or Markdown page body into plain Markdown an AI agent can read without
 * the site's presentation layer. Applied last, after the code expansions in
 * llms-full.ts, by /llms-full.txt and by every page's `/<slug>.md` twin.
 *
 * - ESM `import` / `export` statements and MDX comments are removed.
 * - Starlight components become their Markdown meaning: a `<TabItem label="Bun">`
 *   becomes a bold "Bun" label above its content, an `<Aside>` or a `:::note`
 *   directive becomes a blockquote, a `<Card title>` a bold title, a `<LinkCard>` a
 *   link, and the `<Tabs>`, `<Steps>` and `<CardGrid>` wrappers disappear.
 * - Layout HTML (`<div class>`, `<section>`, `<span>`...) is unwrapped, and inline
 *   HTML (links, emphasis, code, headings, images) becomes Markdown. The decorative
 *   page hero keeps only its summary sentence: the title is already the page title.
 * - Interactive widgets (diagrams, simulators, players) leave a one-line note that
 *   points to the HTML page instead of an empty gap.
 * - With `site`, root-relative links (`/guide/queue/`) become absolute, so a link still
 *   works when the text is read outside the site.
 *
 * Fenced code blocks and inline code are never changed: examples stay byte-for-byte
 * what the HTML page shows.
 */

const FENCE = /^(\s*)(`{3,}|~{3,})/;

/** Components whose children are content and whose tag is only a wrapper. */
const UNWRAP = new Set([
  'Tabs',
  'Steps',
  'CardGrid',
  'div',
  'section',
  'span',
  'figure',
  'small',
  'main',
  'article',
  'header',
  'footer',
  'nav',
  'blockquote',
  'aside',
]);

/** Elements dropped together with everything inside them. */
const DROP = new Set(['script', 'style', 'svg', 'button', 'template']);

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rarr: '→',
  larr: '←',
  middot: '·',
  times: '×',
  check: '✓',
};

type Frame = {
  tag: string;
  attrs: string;
  /** Indentation of the tag itself. */
  indent: string;
  /** Where its content lands: the indentation of the outermost enclosing container,
   *  so nesting depth in JSX never turns prose into an indented code block. */
  target: string;
  lines: string[];
};

const attr = (attrs: string, name: string): string | undefined =>
  new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{['"]([^'"]*)['"]\\})`).exec(attrs)
    ?.slice(1)
    .find((v) => v !== undefined);

const decodeEntities = (text: string) =>
  text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (entity, name) => ENTITIES[name.toLowerCase()] ?? entity);

/** Applies `fn` to the parts of a line outside inline code spans. */
function outsideInlineCode(line: string, fn: (text: string) => string): string {
  const parts = line.split(/(`+[^`]*`+)/);
  return parts.map((part, i) => (i % 2 === 1 ? part : fn(part))).join('');
}

/** Inline HTML to Markdown, outside inline code. */
function inlineHtml(line: string): string {
  return outsideInlineCode(line, (text) =>
    decodeEntities(
      text
        .replace(/\{\/\*.*?\*\/\}/g, '')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<code[^>]*>(.*?)<\/code>/gi, (_, code) => `\`${decodeEntities(code)}\``)
        .replace(/<kbd[^>]*>(.*?)<\/kbd>/gi, (_, key) => `\`${key}\``)
        .replace(/<(strong|b)(\s[^>]*)?>(.*?)<\/\1>/gi, '**$3**')
        .replace(/<(em|i)(\s[^>]*)?>(.*?)<\/\1>/gi, '*$3*')
        .replace(
          /<a\s[^>]*?href\s*=\s*"([^"]*)"[^>]*>(.*?)<\/a>/gi,
          (_, href, label) => `[${label.replace(/<[^>]+>/g, '').trim()}](${href})`
        )
        .replace(/<img\s[^>]*?>/gi, (tag) => {
          const src = attr(tag, 'src');
          return src ? `![${attr(tag, 'alt') ?? ''}](${src})` : '';
        })
        .replace(/<Badge\s[^>]*?\/>/g, (tag) => (attr(tag, 'text') ? ` (${attr(tag, 'text')})` : ''))
        .replace(/<BqIcon\b[^>]*\/>/g, '')
        // Adjacent elements (<span>a</span><span>b</span>) keep a space between texts.
        .replace(/(<\/[A-Za-z][A-Za-z0-9-]*>)(?=<[A-Za-z])/g, '$1 ')
        // Any remaining element tag (HTML or component) is presentation only.
        .replace(/<\/?(?:[a-z][a-z0-9-]*|[A-Z][A-Za-z0-9]*)(?:\s[^<>]*?)?\/?>/g, '')
    )
  );
}

/**
 * Content inside a component or HTML element is indented for the JSX nesting, not for
 * Markdown (where four spaces would start a code block). Prose lines move to `indent`;
 * a fenced block moves as one piece, so its own indentation stays intact.
 */
function dedentTo(lines: string[], indent: string): string[] {
  const out: string[] = [];
  let fenceShift = -1;
  let fence: { marker: string; length: number } | null = null;
  for (const line of lines) {
    const lead = /^[ \t]*/.exec(line)![0].length;
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      out.push(indent + line.slice(Math.min(fenceShift, lead)));
      if (m && m[1][0] === fence.marker && m[1].length >= fence.length && !m[2].trim()) fence = null;
      continue;
    }
    if (m) {
      fence = { marker: m[1][0], length: m[1].length };
      fenceShift = lead;
      out.push(indent + line.slice(lead));
      continue;
    }
    out.push(line.trim() ? indent + line.trimStart() : '');
  }
  return out;
}

const quote = (lines: string[]) => lines.map((l) => (l.trim() ? `> ${l}` : '>'));

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Text of the hero's summary paragraph, the only part of a hero worth keeping. */
function heroSummary(raw: string): string[] {
  const match = /<p[^>]*class\s*=\s*"[^"]*bq-hero-sub[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(raw);
  if (!match) return [];
  return [inlineHtml(match[1].replace(/\s+/g, ' ').trim()), ''];
}

/** Renders a closed container frame into lines of its parent. */
function closeFrame(frame: Frame, raw: string[]): string[] {
  const inner = dedentTo(trimBlank(frame.lines), frame.target);
  const { tag, attrs } = frame;
  const indent = frame.target;
  if (/\bbq-hero\b/.test(attrs)) return heroSummary(raw.join('\n'));
  switch (tag) {
    case 'TabItem': {
      const label = attr(attrs, 'label');
      return ['', ...(label ? [`${indent}**${label}**`, ''] : []), ...inner, ''];
    }
    case 'Aside': {
      const kind = titleCase(attr(attrs, 'type') ?? 'note');
      const title = attr(attrs, 'title');
      const head = `**${kind}${title ? `: ${title}` : ''}**`;
      return ['', ...quote([head, '', ...inner.map((l) => l.slice(indent.length))]).map((l) => indent + l), ''];
    }
    case 'Card': {
      const title = attr(attrs, 'title');
      return ['', ...(title ? [`${indent}**${title}**`, ''] : []), ...inner, ''];
    }
    case 'details':
    case 'summary':
    case 'p':
    case 'li':
    case 'ul':
    case 'ol':
    case 'dl':
    case 'dt':
    case 'dd':
    case 'figcaption':
      return ['', ...inner, ''];
    case 'a':
    case 'LinkButton': {
      // A card or button wrapped in a link: its first line is the label, the rest a note.
      const href = attr(attrs, 'href');
      const text = inner.map((l) => l.trim()).filter(Boolean);
      if (!href || !text.length) return ['', ...inner, ''];
      const [label, ...rest] = text.map((l) => l.replace(/^#+\s*/, '').replace(/^\*\*(.*)\*\*$/, '$1'));
      return ['', `${indent}- [${label}](${href})${rest.length ? `: ${rest.join(' ')}` : ''}`, ''];
    }
    default:
      return ['', ...inner, ''];
  }
}

function trimBlank(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end);
}

/** One-line rendering of a self-closing component, or null to drop it. */
function selfClosing(tag: string, attrs: string, indent: string): string | null {
  if (tag === 'LinkCard') {
    const title = attr(attrs, 'title');
    const href = attr(attrs, 'href');
    const description = attr(attrs, 'description');
    return title && href ? `${indent}- [${title}](${href})${description ? `: ${description}` : ''}` : null;
  }
  if (tag === 'Badge') return attr(attrs, 'text') ? `${indent}(${attr(attrs, 'text')})` : null;
  if (tag === 'img') {
    const src = attr(attrs, 'src');
    return src ? `${indent}![${attr(attrs, 'alt') ?? ''}](${src})` : null;
  }
  if (tag === 'hr') return `${indent}---`;
  if (tag === 'BqIcon' || tag === 'Code' || /^[a-z]/.test(tag)) return null;
  // Diagrams, simulators and players: say what is there instead of leaving a gap.
  return `${indent}*[Interactive ${tag.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}: open the HTML page to view it.]*`;
}

/** A line holding only an opening (or self-closing) tag. Attributes may contain `>`
 *  inside quotes or JSX braces, never bare, so `<h2 id="x">Title</h2>` is not one. */
const OPEN_TAG = /^(\s*)<([A-Za-z][A-Za-z0-9]*)((?:\s(?:"[^"]*"|'[^']*'|\{[^{}]*\}|[^>"'{])*)?)>\s*$/;
/** HTML elements that never have a closing tag. */
const VOID = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'wbr']);
const CLOSE_TAG = /^\s*<\/([A-Za-z][A-Za-z0-9]*)\s*>\s*$/;

export function toAgentMarkdown(body: string, options: { site?: string } = {}): string {
  const source = body.split('\n');
  const root: Frame = { tag: '#root', attrs: '', indent: '', target: '', lines: [] };
  const stack: Frame[] = [root];
  const raws: string[][] = [[]];
  let fence: { marker: string; length: number } | null = null;
  let dropDepth = 0;
  let dropTag = '';
  let directive: { indent: string; lines: string[]; head: string } | null = null;
  let inEsm = false;

  const top = () => stack[stack.length - 1];
  const emit = (...lines: string[]) => {
    if (directive) directive.lines.push(...lines);
    else top().lines.push(...lines);
  };

  for (let i = 0; i < source.length; i++) {
    let line = source[i];
    for (const raw of raws) raw.push(line);

    // Fenced code: copied verbatim, never parsed.
    const opener = FENCE.exec(line);
    if (fence) {
      emit(line);
      if (opener && opener[2][0] === fence.marker && opener[2].length >= fence.length && !line.trim().slice(opener[2].length).trim())
        fence = null;
      continue;
    }
    if (opener && !dropDepth) {
      fence = { marker: opener[2][0], length: opener[2].length };
      emit(line);
      continue;
    }

    // Elements dropped with their contents (scripts, inline SVG).
    if (dropDepth) {
      if (new RegExp(`<${dropTag}[\\s>]`).test(line)) dropDepth++;
      if (new RegExp(`</${dropTag}>`).test(line)) dropDepth--;
      continue;
    }
    const dropOpen = /^\s*<(script|style|svg|button|template)[\s>]/.exec(line);
    if (dropOpen && DROP.has(dropOpen[1])) {
      if (!new RegExp(`</${dropOpen[1]}>`).test(line)) {
        dropTag = dropOpen[1];
        dropDepth = 1;
      }
      continue;
    }

    // ESM statements and MDX comments (a statement may span lines).
    if (inEsm) {
      if (/(from\s+['"][^'"]+['"]|;)\s*$/.test(line) || /^\s*[}\]]\s*;?\s*$/.test(line)) inEsm = false;
      continue;
    }
    if (/^(import|export)\s/.test(line)) {
      if (!/(from\s+['"][^'"]+['"]|['"]);?\s*$/.test(line) && !/;\s*$/.test(line)) inEsm = true;
      continue;
    }
    if (/^\s*\{\/\*.*\*\/\}\s*$/.test(line)) continue;
    if (/^\s*\{\/\*/.test(line)) {
      while (i < source.length && !/\*\/\}/.test(source[i])) i++;
      continue;
    }

    // Starlight directives (:::note[Title] ... :::) become blockquotes.
    const directiveOpen = /^(\s*):::(note|tip|caution|danger)(?:\[(.*?)\])?\s*$/.exec(line);
    if (directiveOpen && !directive) {
      const [, indent, kind, title] = directiveOpen;
      directive = { indent, lines: [], head: `**${titleCase(kind)}${title ? `: ${title}` : ''}**` };
      continue;
    }
    if (directive && /^\s*:::\s*$/.test(line)) {
      const { indent, lines, head } = directive;
      directive = null;
      emit('', ...quote([head, '', ...trimBlank(lines).map((l) => l.slice(indent.length))]).map((l) => indent + l), '');
      continue;
    }

    // A tag that continues over several lines: join it before matching.
    if (/^\s*<[A-Za-z]/.test(line) && !/>\s*$/.test(line) && !/<\/[A-Za-z]/.test(line)) {
      let j = i;
      let joined = line;
      while (j + 1 < source.length && j - i < 40 && !/>\s*$/.test(joined)) {
        j++;
        joined += ` ${source[j].trim()}`;
      }
      if (OPEN_TAG.test(joined)) {
        for (const raw of raws) raw.push(...source.slice(i + 1, j + 1));
        i = j;
        line = joined;
      }
    }

    const close = CLOSE_TAG.exec(line);
    if (close && stack.length > 1 && top().tag === close[1]) {
      const frame = stack.pop()!;
      const raw = raws.pop()!;
      top().lines.push(...closeFrame(frame, raw));
      continue;
    }
    if (close) continue; // a stray closing wrapper

    const open = OPEN_TAG.exec(line);
    if (open) {
      const [, indent, tag] = open;
      const selfClose = /\/\s*$/.test(open[3] ?? '');
      const attrs = (open[3] ?? '').replace(/\/\s*$/, '');
      if (selfClose || VOID.has(tag.toLowerCase())) {
        const rendered = selfClosing(tag, attrs, indent);
        if (rendered !== null) emit(rendered);
        continue;
      }
      const target = stack.length === 1 ? indent : top().target;
      stack.push({ tag, attrs, indent, target, lines: [] });
      raws.push([line]);
      continue;
    }

    // A whole element on one line, such as <p class="x">Text</p> or <h2>Title</h2>.
    const heading = /^(\s*)<h([1-6])[^>]*>(.*?)<\/h\2>\s*$/.exec(line);
    if (heading) {
      emit(`${heading[1]}${'#'.repeat(Number(heading[2]))} ${inlineHtml(heading[3]).trim()}`);
      continue;
    }
    const item = /^(\s*)<li[^>]*>(.*?)<\/li>\s*$/.exec(line);
    if (item) {
      emit(`${item[1]}- ${inlineHtml(item[2]).trim()}`);
      continue;
    }
    const term = /^(\s*)<dt[^>]*>(.*?)<\/dt>\s*$/.exec(line);
    if (term) {
      emit('', `${term[1]}**${inlineHtml(term[2]).trim()}**`);
      continue;
    }
    const summary = /^(\s*)<summary[^>]*>(.*?)<\/summary>\s*$/.exec(line);
    if (summary) {
      emit('', `${summary[1]}**${inlineHtml(summary[2]).trim()}**`, '');
      continue;
    }
    const aside = /^(\s*)<Aside([^>]*)>(.*)<\/Aside>\s*$/.exec(line);
    if (aside) {
      const kind = titleCase(attr(aside[2], 'type') ?? 'note');
      emit('', `${aside[1]}> **${kind}:** ${inlineHtml(aside[3]).trim()}`, '');
      continue;
    }

    emit(inlineHtml(line));
  }

  // Unclosed frames (malformed source): keep their content rather than lose it.
  while (stack.length > 1) {
    const frame = stack.pop()!;
    top().lines.push(...frame.lines);
  }
  if (directive) root.lines.push(...directive.lines);

  // A run of interactive widgets (the homepage sections) reads as one note.
  const WIDGET = /^\s*\*\[Interactive (.+): open the HTML page to view it\.\]\*$/;
  for (let i = 0; i < root.lines.length; i++) {
    const first = WIDGET.exec(root.lines[i]);
    if (!first) continue;
    const names = [first[1]];
    let j = i + 1;
    while (j < root.lines.length) {
      if (!root.lines[j].trim()) { j++; continue; }
      const next = WIDGET.exec(root.lines[j]);
      if (!next) break;
      names.push(next[1]);
      j++;
    }
    if (names.length > 1) {
      root.lines.splice(i, j - i, `*[Interactive sections (${[...new Set(names)].join(', ')}): open the HTML page to view them.]*`, '');
    }
  }

  // Collapse runs of blank lines and trailing spaces, but only outside fenced code:
  // examples keep every byte, blank lines included.
  const out: string[] = [];
  let open: { marker: string; length: number } | null = null;
  for (const line of root.lines) {
    const m = /^\s*(?:>\s?)*\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (open) {
      out.push(line);
      if (m && m[1][0] === open.marker && m[1].length >= open.length && !m[2].trim()) open = null;
      continue;
    }
    if (m) open = { marker: m[1][0], length: m[1].length };
    let clean = line.replace(/[ \t]+$/, '');
    if (options.site) {
      const site = options.site.replace(/\/$/, '');
      clean = outsideInlineCode(clean, (text) => text.replace(/\]\((\/(?!\/)[^)\s]*)\)/g, `](${site}$1)`));
    }
    if (!clean.trim() && (!out.length || !out[out.length - 1].trim())) continue;
    out.push(clean);
  }
  return `${out.join('\n').trim()}\n`;
}
