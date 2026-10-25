---
title: "bunqueue v2.6.41"
description: "bunqueue Cloud: enterprise-grade telemetry: Snapshot now includes per-queue totals (totalCompleted/totalFailed), connection stats (TCP/WS/SSE clients), webhook delivery stats, top errors grouped by message, cron execution counts, S3…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-41.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.41</em></h1>
  <p class="bq-hero-sub">bunqueue Cloud: enterprise-grade telemetry: Snapshot now includes per-queue totals (totalCompleted/totalFailed), connection stats (TCP/WS/SSE clients), webhook delivery stats, top errors grouped by message, cron execution counts, S3…</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.41

```bash title="bun"
bun add bunqueue@2.6.41
```

```bash title="npm"
npm install bunqueue@2.6.41
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Enhanced

- **bunqueue Cloud: enterprise-grade telemetry**: Snapshot now includes per-queue totals (`totalCompleted`/`totalFailed`), connection stats (TCP/WS/SSE clients), webhook delivery stats, top errors grouped by message, cron execution counts, S3 backup status, rate limit and concurrency config per queue. Added `job:logs` and `job:result` remote commands for on-demand data. Auth errors (401/403) now logged at error level instead of silently buffered.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.40](/blog/bunqueue-v2-6-40/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.41) · [Commits since v2.6.40](https://github.com/egeominotti/bunqueue/compare/v2.6.40...v2.6.41) · [Full changelog](/changelog/) · [All posts](/blog/)
