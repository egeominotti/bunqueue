---
title: "bunqueue v2.6.92"
description: "Simple Mode: 4 new production features."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-92.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-31"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.92</em></h1>
  <p class="bq-hero-sub">Simple Mode: 4 new production features.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.92

```bash title="bun"
bun add bunqueue@2.6.92
```

```bash title="npm"
npm install bunqueue@2.6.92
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Simple Mode: 4 new production features

(zero core modifications):
- **Job Deduplication**: auto-dedup by name+data with configurable TTL, extend, replace modes
- **Job Debouncing**: coalesce rapid same-name jobs within a TTL window
- **Rate Limiting**: `rateLimit` option (max/duration/groupKey) + runtime `setGlobalRateLimit()`
- **DLQ Auto-Management**: `dlq` option for auto-retry, max age, max entries; full DLQ API (getDlq, getDlqStats, retryDlq, purgeDlq)

## More additions

- 9 new unit tests for the 4 features

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.91](/blog/bunqueue-v2-6-91/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.92) · [Commits since v2.6.91](https://github.com/egeominotti/bunqueue/compare/v2.6.91...v2.6.92) · [Full changelog](/changelog/) · [All posts](/blog/)
