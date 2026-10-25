---
title: "bunqueue v2.6.7"
description: "Fixes 2 bugs and ships 1 performance improvement. 53 new test suites."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-7.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-08"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.7</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs and ships 1 performance improvement. 53 new test suites.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.7

```bash title="bun"
bun add bunqueue@2.6.7
```

```bash title="npm"
npm install bunqueue@2.6.7
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## 53 new test suites

Comprehensive test coverage across embedded and TCP modes:
- **Batch 1–3 (19 embedded + 18 TCP):** stress, ETL, retry, cron, queue group, shutdown, backpressure, priorities, lifecycle, data integrity, deduplication, timeouts, flows, removal, pause/resume, worker scaling, cancellation, DLQ patterns, bulk ops
- **Coverage gap tests (16 embedded):** auto-batching, webhook delivery, durable jobs, rate limiting, lock race conditions, flow + stall detection, cron timezone/DST, LIFO queue, DLQ selective retry, S3 backup concurrent, webhook SSRF, MCP edge cases, CLI error formatting, flow deduplication, sandboxed worker + flow, queue group + flow

## More additions

- Total test count increased from ~4,000 to 4,903

## Performance

- CronScheduler `scheduleNext()` now handles stale entries in O(k) amortized instead of blocking indefinitely

## Bugfixes

- **CronScheduler stale heap bug**: When a cron job was removed, `scheduleNext()` encountered the stale heap entry and returned early without setting any timer, preventing all subsequent crons from firing. Now properly pops stale entries from the min-heap until a valid one is found. ([#33](https://github.com/egeominotti/bunqueue/issues/33))
- **Graceful shutdown burst load**: Fixed `worker.close(true)` causing unhandled AckBatcher errors when jobs were still completing during burst load scenarios. Changed to graceful close with proper drain.

## Documentation

- Removed BullMQ-only WorkerOptions from API types (lockDuration, maxStalledCount, etc.)
- Added auto-batching documentation to Queue guide
- Added connection pool sizing note to Worker guide
- Fixed CLI help: removed non-existent socket options, fake interactive prompts

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.6](/blog/bunqueue-v2-6-6/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.7) · [Commits since v2.6.6](https://github.com/egeominotti/bunqueue/compare/v2.6.6...v2.6.7) · [Full changelog](/changelog/) · [All posts](/blog/)
