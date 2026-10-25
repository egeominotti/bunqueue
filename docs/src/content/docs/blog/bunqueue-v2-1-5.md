---
title: "bunqueue v2.1.5"
description: "Fixes 3 bugs. uncaughtException and unhandledRejection handlers - Previously, any uncaught error in background tasks or unhandled promise rejections would crash the server immediately without cleanup (write buffer not flushed, SQLite not…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-1-5.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-02-05"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.1.5</em></h1>
  <p class="bq-hero-sub">Fixes 3 bugs. uncaughtException and unhandledRejection handlers - Previously, any uncaught error in background tasks or unhandled promise rejections would crash the server immediately without cleanup (write buffer not flushed, SQLite not…</p>
</div>

#### To install bunqueue v2.1.5

```bash title="bun"
bun add bunqueue@2.1.5
```

```bash title="npm"
npm install bunqueue@2.1.5
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Changes

- Migrated documentation from GitHub Pages to Vercel deployment
- SEO optimization across all 45 pages with improved titles and descriptions
- Documentation errors fixed, missing content added, and navbar modernized

## Bugfixes

- **uncaughtException and unhandledRejection handlers** - Previously, any uncaught error in background tasks or unhandled promise rejections would crash the server immediately without cleanup (write buffer not flushed, SQLite not closed, locks not released). Now the server performs graceful shutdown: logs the error with stack trace, stops TCP/HTTP servers, waits for active jobs, flushes the write buffer, and exits cleanly.
- Broken GitHub links in documentation (missing `/bunqueue` in paths)
- Stray separator in index.mdx causing build error

---

[← bunqueue v2.1.4](/blog/bunqueue-v2-1-4/) · [Full changelog](/changelog/) · [All posts](/blog/)
