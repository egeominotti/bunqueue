---
title: "bunqueue v1.4.0"
description: "Rate limiting per queue, concurrency limiting per queue, prometheus metrics endpoint, health check endpoint."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v1-4-0.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-01-10"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v1.4.0</em></h1>
  <p class="bq-hero-sub">Rate limiting per queue, concurrency limiting per queue, prometheus metrics endpoint, health check endpoint.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v1.4.0

```bash title="bun"
bun add bunqueue@1.4.0
```

```bash title="npm"
npm install bunqueue@1.4.0
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

- Rate limiting per queue
- Concurrency limiting per queue
- Prometheus metrics endpoint
- Health check endpoint

## Changes

- Optimized batch operations (3x faster)
- Reduced memory usage for large queues

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v1.3.0](/blog/bunqueue-v1-3-0/) · [Commits since v1.3.0](https://github.com/egeominotti/bunqueue/compare/v1.3.0...v1.4.0) · [Full changelog](/changelog/) · [All posts](/blog/)
