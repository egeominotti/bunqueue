---
title: "bunqueue v2.6.42"
description: "Fixes 1 bug and ships 1 performance improvement. Cloud: two-tier snapshot collection: Light data (stats, throughput, latency, memory) collected every 5s at O(SHARD_COUNT)."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-42.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-19"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.42</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug and ships 1 performance improvement. Cloud: two-tier snapshot collection: Light data (stats, throughput, latency, memory) collected every 5s at O(SHARD_COUNT).</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.42

```bash title="bun"
bun add bunqueue@2.6.42
```

```bash title="npm"
npm install bunqueue@2.6.42
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Performance

- **Cloud: two-tier snapshot collection**: Light data (stats, throughput, latency, memory) collected every 5s at O(SHARD_COUNT). Heavy data (recentJobs, dlqEntries, topErrors, workerDetails, queueConfigs, webhooks) collected every 30s and cached between refreshes. Heavy collectors skip empty queues (only iterate queues with waiting/active/dlq > 0). Eliminated double `getQueueJobCounts()` pass.

## Bugfixes

- **Cloud: totalCompleted/totalFailed per queue**: Was sending in-memory BoundedSet count (resets when full). Now sends cumulative counters from `perQueueMetrics` (never resets).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.41](/blog/bunqueue-v2-6-41/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.42) · [Commits since v2.6.41](https://github.com/egeominotti/bunqueue/compare/v2.6.41...v2.6.42) · [Full changelog](/changelog/) · [All posts](/blog/)
