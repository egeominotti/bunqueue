---
title: "bunqueue v1.9.2"
description: "Fixes 1 bug. Critical Memory Leak - Resolved temporalIndex leak causing 5.5M object retention after 1M jobs - Added cleanOrphanedTemporalEntries() method to Shard - Memory now properly released after job completion with removeOnComplete…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v1-9-2.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-01-30"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v1.9.2</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Critical Memory Leak - Resolved temporalIndex leak causing 5.5M object retention after 1M jobs - Added cleanOrphanedTemporalEntries() method to Shard - Memory now properly released after job completion with removeOnComplete…</p>
</div>

#### To install bunqueue v1.9.2

```bash title="bun"
bun add bunqueue@1.9.2
```

```bash title="npm"
npm install bunqueue@1.9.2
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Changes

- Improved error logging in ackBatcher flush operations

## Bugfixes

- **Critical Memory Leak** - Resolved `temporalIndex` leak causing 5.5M object retention after 1M jobs
  - Added `cleanOrphanedTemporalEntries()` method to Shard
  - Memory now properly released after job completion with `removeOnComplete: true`
  - `heapUsed` drops to ~6MB after processing (vs 264MB before fix)

---

[← bunqueue v1.9.1](/blog/bunqueue-v1-9-1/) · [Full changelog](/changelog/) · [All posts](/blog/)
