---
title: "bunqueue v2.0.3"
description: "Fixes 6 bugs. Major refactor: Split queue.ts into modular architecture (1955 → 485 lines) - Follows single responsibility principle with 14 focused modules - New modules: operations/add.ts, operations/counts.ts, operations/query.ts…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-0-3.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-02-02"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.0.3</em></h1>
  <p class="bq-hero-sub">Fixes 6 bugs. Major refactor: Split queue.ts into modular architecture (1955 → 485 lines) - Follows single responsibility principle with 14 focused modules - New modules: operations/add.ts, operations/counts.ts, operations/query.ts…</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.0.3

```bash title="bun"
bun add bunqueue@2.0.3
```

```bash title="npm"
npm install bunqueue@2.0.3
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Changes

- **Major refactor: Split queue.ts into modular architecture** (1955 → 485 lines)
  - Follows single responsibility principle with 14 focused modules
  - New modules: operations/add.ts, operations/counts.ts, operations/query.ts, operations/management.ts, operations/cleanup.ts, operations/control.ts
  - New modules: jobMove.ts, jobProxy.ts, bullmqCompat.ts, scheduler.ts, dlq.ts, stall.ts, rateLimit.ts, deduplication.ts, workers.ts, queueTypes.ts
  - All 894 unit tests, 25 TCP test suites, and 32 embedded test suites pass

## Bugfixes

- `getJob()` now properly awaits async manager.getJob() call
- `getJobCounts()` now uses queue-specific counts instead of global stats
- `promoteJobs()` implements correct iteration over delayed jobs
- `addBulk()` properly passes BullMQ v5 options (lifo, stackTraceLimit, keepLogs, etc.)
- `toPublicJob()` used for full job options support in getJob()
- `extendJobLock()` passes token parameter correctly

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.0.2](/blog/bunqueue-v2-0-2/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.0.3) · [Commits since v2.0.2](https://github.com/egeominotti/bunqueue/compare/v2.0.2...v2.0.3) · [Full changelog](/changelog/) · [All posts](/blog/)
