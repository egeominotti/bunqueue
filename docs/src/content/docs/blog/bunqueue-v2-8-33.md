---
title: "bunqueue v2.8.33"
description: "Fixes 3 bugs. SQLite startup recovery no longer skips the row that crosses a shrinking OFFSET page boundary."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-33.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-16"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.33</em></h1>
  <p class="bq-hero-sub">Fixes 3 bugs. SQLite startup recovery no longer skips the row that crosses a shrinking OFFSET page boundary.</p>
</div>

#### To install bunqueue v2.8.33

```bash title="bun"
bun add bunqueue@2.8.33
```

```bash title="npm"
npm install bunqueue@2.8.33
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Improved: summaries, temporal indexes, waiters, and delayed-heap memory

- Queue summaries use one aggregation pass and include `prioritized` jobs
  explicitly. HTTP/SSE/WebSocket queue-count refreshes are coalesced through a
  shared scheduler instead of rescanning global state once per queue. The
  200-queue/50k-job benchmark improves from 503.6 ms to 4.9 ms median
  (approximately 103x).
- Temporal cleanup now uses a queue-local ordered index plus direct job-ID
  lookup. In the 500k-unrelated-job benchmark, sparse lookup improves by about
  14,935x and removal by about 3,108x.
- Waiters now use queue-local cursor deques, cancel fulfilled timers
  immediately, compact stale entries proportionally, and coalesce surplus
  notifications instead of accumulating false pull credits. Notifying 10,000
  waiters improves from 446 ms to 0.8 ms median (approximately 553x).
- Lazy-deleted delayed-heap entries are rebuilt after a stale threshold and the
  heap is cleared immediately when no delayed job remains. A 100,000 add/remove
  churn now retains zero heap entries instead of 100,000.

Every confirmed bug has a focused regression test. The release also adds a
reproducible before/after benchmark harness and report, synchronizes the
internal technical reference, and audits the Astro site and root README against
the current protocol, HTTP events, state model, environment variables, indexes,
and runtime behavior.

## Bugfixes

- SQLite startup recovery no longer skips the row that crosses a shrinking
  `OFFSET` page boundary. Active jobs are recovered in stable offset-zero
  batches, each transition updates counters exactly once, and corrupt pending
  rows are quarantined only after stable pagination completes. A 10,001-job
  regression now recovers all 10,001 jobs with no active row left behind.
- `getJobs()` now filters, sorts, and paginates in the correct order in both
  memory and SQLite. Descending pages are selected from the globally ordered
  result; logical `waiting`, `prioritized`, and `delayed` predicates execute in
  SQL before `LIMIT`/`OFFSET`; equal timestamps use job ID as a deterministic
  tie-breaker. New queue/creation indexes remove SQLite's temporary ORDER BY
  B-tree on deep pages.
- Pull no longer returns `null` merely because the heap head belongs to an
  already-active FIFO group. Blocked candidates are parked while the pull scans
  for an eligible group and are then restored without changing queue counters
  or indexes. Group and concurrency releases also wake the appropriate
  queue-local long poll. Existing delayed-head semantics remain unchanged.

---

[← bunqueue v2.8.32](/blog/bunqueue-v2-8-32/) · [Full changelog](/changelog/) · [All posts](/blog/)
