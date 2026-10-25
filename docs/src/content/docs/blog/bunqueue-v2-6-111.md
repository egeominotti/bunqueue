---
title: "bunqueue v2.6.111"
description: "Fixes 1 bug. bunqueue stats showing zeros for waiting/active: TCP Stats command was returning fields named queued/processing while the CLI expected waiting/active."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-111.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-04-03"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.111</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. bunqueue stats showing zeros for waiting/active: TCP Stats command was returning fields named queued/processing while the CLI expected waiting/active.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.111

```bash title="bun"
bun add bunqueue@2.6.111
```

```bash title="npm"
npm install bunqueue@2.6.111
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **`bunqueue stats` showing zeros for waiting/active**: TCP Stats command was returning fields named `queued`/`processing` while the CLI expected `waiting`/`active`. Aligned TCP response to use standard field names (`waiting`, `active`, `failed`) consistent with HTTP `/health` endpoint.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.110](/blog/bunqueue-v2-6-110/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.111) · [Commits since v2.6.110](https://github.com/egeominotti/bunqueue/compare/v2.6.110...v2.6.111) · [Full changelog](/changelog/) · [All posts](/blog/)
