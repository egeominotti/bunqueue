---
title: "bunqueue v2.0.2"
description: "Fixes 1 bug. loadCompletedJobIds() method in SQLite storage for dependency recovery, hasResult() method to check if job result exists in SQLite."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-0-2.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.0.2</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. loadCompletedJobIds() method in SQLite storage for dependency recovery, hasResult() method to check if job result exists in SQLite.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.0.2

```bash title="bun"
bun add bunqueue@2.0.2
```

```bash title="npm"
npm install bunqueue@2.0.2
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

- `loadCompletedJobIds()` method in SQLite storage for dependency recovery
- `hasResult()` method to check if job result exists in SQLite
- Comprehensive recovery test suite (`test/recoveryLogic.test.ts`) with 8 tests covering all scenarios

## Bugfixes

- **Critical: Complete recovery logic for deduplication after restart** - Fixed all recovery scenarios that caused duplicate jobs after server restart:
  - **jobId deduplication** (`customIdMap`) - Now properly populated on recovery
  - **uniqueKey TTL deduplication** - Now restored with TTL settings via `registerUniqueKeyWithTtl()`
  - **Dependency recovery** - Now checks SQLite `job_results` table (not just in-memory `completedJobs`)
  - **Counter consistency** - Fixed `incrementQueued()` only called for main queue jobs, not `waitingDeps`

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.0.1](/blog/bunqueue-v2-0-1/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.0.2) · [Commits since v2.0.1](https://github.com/egeominotti/bunqueue/compare/v2.0.1...v2.0.2) · [Full changelog](/changelog/) · [All posts](/blog/)
