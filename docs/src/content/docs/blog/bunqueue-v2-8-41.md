---
title: "bunqueue v2.8.41"
description: "Ships 3 performance improvements. pullBatch now parks delayed and active-group-blocked candidates in one scratch area for the entire batch, then restores them once before releasing the shard lock."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-41.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-19"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.41</em></h1>
  <p class="bq-hero-sub">Ships 3 performance improvements. pullBatch now parks delayed and active-group-blocked candidates in one scratch area for the entire batch, then restores them once before releasing the shard lock.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.41

```bash title="bun"
bun add bunqueue@2.8.41
```

```bash title="npm"
npm install bunqueue@2.8.41
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Performance

- `pullBatch` now parks delayed and active-group-blocked candidates in one
  scratch area for the entire batch, then restores them once before releasing
  the shard lock. This removes the repeated extract/reinsert cycle for every
  delivered job while preserving priority, FIFO groups, limiter accounting,
  long-poll deadlines and queue indexes.
- Native benchmarks with 50,000 ineligible jobs and a batch of 100 improved
  active-group backlogs from roughly 1.54 seconds to 18 milliseconds (about
  85x) and delayed backlogs from roughly 1.45 seconds to 16 milliseconds
  (about 90x).
- Regression coverage verifies single restoration, partial batches under
  concurrency limits, earliest delayed wake-up and exception-safe restoration.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.40](/blog/bunqueue-v2-8-40/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.41) · [Commits since v2.8.40](https://github.com/egeominotti/bunqueue/compare/v2.8.40...v2.8.41) · [Full changelog](/changelog/) · [All posts](/blog/)
