---
title: "bunqueue v2.6.74"
description: "Cloud: dynamic ingest interval: Snapshot interval now adapts automatically to payload size: < 50KB → 5s, 50–200KB → 10s, 200–500KB → 20s, > 500KB → 30s."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-74.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-23"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.74</em></h1>
  <p class="bq-hero-sub">Cloud: dynamic ingest interval: Snapshot interval now adapts automatically to payload size: &lt; 50KB → 5s, 50–200KB → 10s, 200–500KB → 20s, &gt; 500KB → 30s.</p>
</div>

#### To install bunqueue v2.6.74

```bash title="bun"
bun add bunqueue@2.6.74
```

```bash title="npm"
npm install bunqueue@2.6.74
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Changes

- **Cloud: dynamic ingest interval**: Snapshot interval now adapts automatically to payload size: < 50KB → 5s, 50–200KB → 10s, 200–500KB → 20s, > 500KB → 30s. Previously fixed at 15s regardless of load.
- **Cloud: unbounded job collection**: Removed the 10k total cap on `recentJobs[]`. Each state is now collected in full, bounded only by in-memory eviction limits (50k completed FIFO, etc).
- **Cloud: removed `/batch` ingest endpoint**: Recovery now resends buffered snapshots one-by-one to the standard `/api/v1/ingest` endpoint, simplifying the protocol.

---

[← bunqueue v2.6.73](/blog/bunqueue-v2-6-73/) · [Full changelog](/changelog/) · [All posts](/blog/)
