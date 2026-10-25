---
title: "bunqueue v2.6.36"
description: "Fixes 1 bug. /queues/:queue/jobs/list performance: Endpoint was taking 300-450ms even with limit=2 because it scanned the entire jobIndex (O(N) iterations + O(N) individual SQLite lookups) then sorted all results."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-36.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-17"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.36</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. /queues/:queue/jobs/list performance: Endpoint was taking 300-450ms even with limit=2 because it scanned the entire jobIndex (O(N) iterations + O(N) individual SQLite lookups) then sorted all results.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.36

```bash title="bun"
bun add bunqueue@2.6.36
```

```bash title="npm"
npm install bunqueue@2.6.36
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **`/queues/:queue/jobs/list` performance**: Endpoint was taking 300-450ms even with `limit=2` because it scanned the entire jobIndex (O(N) iterations + O(N) individual SQLite lookups) then sorted all results. Now delegates to a single indexed SQLite query with `LIMIT/OFFSET`, reducing response time to <5ms.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.35](/blog/bunqueue-v2-6-35/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.36) · [Commits since v2.6.35](https://github.com/egeominotti/bunqueue/compare/v2.6.35...v2.6.36) · [Full changelog](/changelog/) · [All posts](/blog/)
