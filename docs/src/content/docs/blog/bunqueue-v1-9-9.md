---
title: "bunqueue v1.9.9"
description: "Fixes 4 bugs. Comprehensive Functional Test Suite."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v1-9-9.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-02-01"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v1.9.9</em></h1>
  <p class="bq-hero-sub">Fixes 4 bugs. Comprehensive Functional Test Suite.</p>
</div>

#### To install bunqueue v1.9.9

```bash title="bun"
bun add bunqueue@1.9.9
```

```bash title="npm"
npm install bunqueue@1.9.9
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Comprehensive Functional Test Suite

28 new test files covering all major features
- 14 embedded mode tests + 14 TCP mode tests
- Tests for: advanced DLQ, job management, monitoring, rate limiting, stall detection, webhooks, queue groups, and more
- All 24 embedded test suites pass (143/143 individual tests)

## Changes

- **BullMQ-Style Idempotency** - `jobId` option now returns existing job instead of throwing error
  - Duplicate job submissions are idempotent (same behavior as BullMQ)
  - Cleaner handling of retry scenarios without error handling
- Improved documentation for `jobId` deduplication behavior

## Bugfixes

- Embedded test suite now properly uses embedded mode (was incorrectly trying TCP)
- Fixed `getJobCounts()` in tests to use queue-specific `getJobs()` method
- Fixed async `getJob()` calls in job management tests
- Fixed PROMOTE, CHANGE PRIORITY, and MOVE TO DELAYED test logic

---

[← bunqueue v1.9.8](/blog/bunqueue-v1-9-8/) · [Full changelog](/changelog/) · [All posts](/blog/)
