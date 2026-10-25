---
title: "bunqueue v2.8.49"
description: "Fixes 9 bugs. Documentation site only: five responsive layout defects and the SEO gaps found by auditing all 83 pages at 390 / 834 / 1024 / 1440px (332 measurements) plus the production build's 319 HTML files."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-49.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-30"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.49</em></h1>
  <p class="bq-hero-sub">Fixes 9 bugs. Documentation site only: five responsive layout defects and the SEO gaps found by auditing all 83 pages at 390 / 834 / 1024 / 1440px (332 measurements) plus the production build's 319 HTML files.</p>
</div>

Documentation site only: five responsive layout defects and the SEO gaps found by auditing
all 83 pages at 390 / 834 / 1024 / 1440px (332 measurements) plus the production build's
319 HTML files. No library code, no runtime behaviour, no published package contents
changed.

#### To install bunqueue v2.8.49

```bash title="bun"
bun add bunqueue@2.8.49
```

```bash title="npm"
npm install bunqueue@2.8.49
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Changes

- `X-Robots-Tag: noindex, follow` for the versioned TypeDoc dump under
  `/reference/v<version>/`. Those 236 static pages are 74% of the crawlable surface and
  carry no canonical, no per-page description (all 236 read "Documentation for bunqueue"),
  duplicate titles and a 93-word median. They stay crawlable and linkable for humans and
  drop out of the search index — which also defuses the version-churn trap, since a bump
  to the next reference path leaves no indexed URLs behind to 404. The per-page markdown
  twins (`*.md`, for AI crawlers) get `noindex` for the same duplicate-content reason;
  `llms.txt` and `llms-full.txt` are unaffected.
- Article structured data now carries a real `datePublished`, taken from each page's first
  commit, alongside the existing git-derived `dateModified`. Blog posts keep their
  frontmatter publication date and take `dateModified` from git rather than repeating the
  publication date.
- `twitter:image` (and its alt text) is now emitted on every page. X fell back to
  `og:image`, but the Card Validator checks for the explicit tag.

## Bugfixes

- **Vercel rejected the documentation deployment before Astro could start.**
  Explanatory text for the two `X-Robots-Tag` routes had been encoded as
  synthetic `"//"` properties inside `vercel.json`; Vercel's schema rejects
  unknown header-rule keys. The rationale now lives in the technical
  architecture reference, the deployed JSON contains only supported fields,
  and a regression test guards the boundary.
- **The "On this page" table of contents was truncated at every desktop width.** Starlight
  sizes the TOC column as `sidebar-width + (100% - content-width - sidebar-width) / 2`,
  which assumes a capped `--sl-content-width`; ours is `100%`, so the term went negative,
  the column collapsed to 9rem and the fixed panel (`width: 100%`, i.e. 100% of the
  viewport, offset by its static position) ran past the right edge. Every entry lost its
  tail — 61px at 1152px, 93px at 1280px, 121px from 1440px up, measured identically in a
  real 1888px window. The TOC now gets a real `--sl-sidebar-width` column and the main
  pane gives back the same width, so the two flex items still total 100%.
- **The header pushed its own controls off-screen between 800px and 1056px.** Above 50rem
  Starlight swaps the menu button for the sidebar, so the header grid has to fit title +
  search + the entire right group (nav links, socials, theme select, CTA — 581px
  intrinsic) beside an 18rem sidebar column that cannot shrink. On iPad portrait (834px)
  209px of that group sat outside the viewport: no theme toggle and no "Get started" at
  all. At 1024px (iPad landscape, 1024-wide laptops) the CTA was still cut through the
  middle. The four secondary nav links now step aside in that band; all four remain in the
  footer.
- **Body text sat 3px from both screen edges on phones.** The phone layer zeroes the
  content panel's inline padding so cards, code blocks and the terminal can run edge to
  edge, and `.bq-wrap` handed the gutter back — but 81 of 83 pages open with a `.bq-hero`
  and then continue in plain markdown, which is not inside `.bq-wrap`. Prose, headings,
  lists and tables were left with a 3px gutter while the hero above them had 19px. The
  text flow now carries its own 1rem gutter; the full-bleed blocks are deliberately
  untouched. The footer (logo, link columns, legal line) had the same problem and now
  matches.
- **Tab strips squashed instead of scrolling on tablet portrait.** The rule that keeps tab
  labels intact was scoped to `max-width: 40rem`, but the strip is starved wherever the
  content column is narrower than its natural width — which also happens from 800px to
  1000px, where the sidebar cuts the column to 472-598px against a 619px strip. Labels
  shrank below min-content and wrapped letter by letter ("B/u/n" over three lines, 70px
  tall instead of 29px) on 19 pages. The rule is no longer breakpoint-scoped.
- **The simulator page scrolled sideways between 965px and 1120px.** `.sim-grid` collapsed
  to one column only below 960px, while the rule that widens the content column to 88rem
  starts at 72rem. In the gap the viewport looks roomy but the docs sidebar leaves ~664px,
  so the `290px + 1fr` grid (plus the nested `1fr 1fr` row) overflowed the page by up to
  120px — and the fixed sidebar then covered the shifted text. The collapse breakpoint now
  meets the widening rule exactly.
- **Every page carried two `<h1>` elements.** Starlight renders the frontmatter title as
  the page `<h1>`; on the 81 hero pages custom CSS hides the panel containing it, so the
  keyword-bearing heading lived in a `display: none` subtree while the hero supplied a
  second `<h1>`. A `PageTitle` override keeps the real `<h1>` on pages that actually
  display it and downgrades it to a `<div>` (same `#_top` anchor, which the TOC links to)
  where the hero already owns the heading. `architecture/model-based-testing` also had a
  redundant `# ` heading duplicating its own title; removed.
- **The simulator skipped from `<h1>` to `<h3>`.** Its nine panel titles are now `<h2>`,
  so the page no longer breaks heading order.
- **Six meta descriptions were long enough to be truncated in search results** (up to 233
  characters). All 83 are now ≤160.

---

[← bunqueue v2.8.48](/blog/bunqueue-v2-8-48/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.49) · [Commits since v2.8.48](https://github.com/egeominotti/bunqueue/compare/v2.8.48...v2.8.49) · [Full changelog](/changelog/) · [All posts](/blog/)
