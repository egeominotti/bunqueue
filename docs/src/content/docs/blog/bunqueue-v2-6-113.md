---
title: "bunqueue v2.6.113"
description: "Fixes 1 bug. Cron job with preventOverlap fires immediately on reconnect: Lock expiration was re-queuing cron jobs instead of discarding them, and batch ACK (ackBatchWithResults) silently skipped stall-retried jobs without recovery."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-113.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.113</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Cron job with preventOverlap fires immediately on reconnect: Lock expiration was re-queuing cron jobs instead of discarding them, and batch ACK (ackBatchWithResults) silently skipped stall-retried jobs without recovery.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.113

```bash title="bun"
bun add bunqueue@2.6.113
```

```bash title="npm"
npm install bunqueue@2.6.113
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Cron job with `preventOverlap` fires immediately on reconnect**: Lock expiration was re-queuing cron jobs instead of discarding them, and batch ACK (`ackBatchWithResults`) silently skipped stall-retried jobs without recovery. Now cron jobs are discarded on lock expiry (the scheduler re-creates them at the next tick), and batch ACK properly recovers stall-retried jobs like single ACK does. Reported as #75.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.112](/blog/bunqueue-v2-6-112/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.113) · [Commits since v2.6.112](https://github.com/egeominotti/bunqueue/compare/v2.6.112...v2.6.113) · [Full changelog](/changelog/) · [All posts](/blog/)
