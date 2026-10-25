---
title: "bunqueue v2.8.5"
description: "Fixes 4 bugs. the same custom jobId in two different queues sharing one database, or"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-5.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-06-05"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.5</em></h1>
  <p class="bq-hero-sub">Fixes 4 bugs. the same custom jobId in two different queues sharing one database, or</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.5

```bash title="bun"
bun add bunqueue@2.8.5
```

```bash title="npm"
npm install bunqueue@2.8.5
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

A duplicate `jobs.id` (the global PRIMARY KEY) poisoned the entire atomic write-buffer
flush: the failing batch rolled back as a whole, was retried, and after exhausting
retries **every job in that flush window was dropped, including unrelated, valid jobs**
that merely happened to be batched together. Silent, unrecoverable, and triggerable by a
single duplicated custom `jobId`. Two ways to hit it:

- the **same custom `jobId` in two different queues** sharing one database, or
- **reusing a custom `jobId` after its job completed**: `markCompleted` UPDATEs the row
  (it survives), so the reused, deterministic id collided with it.

Fixes:

- **Per-row isolation on flush.** When the fast atomic batch INSERT fails, the buffer now
  re-inserts row by row: valid jobs persist, a constraint violation (e.g. duplicate id) is
  isolated and dropped (it can never succeed, so it is no longer retried, which is what
  poisoned every subsequent flush), and genuinely transient failures (disk I/O, full) are
  retried exactly as before. The success path is unchanged (a single transaction).
- **Completed-id reuse evicts the stale job.** Re-adding a completed custom `jobId` now
  evicts the old completed record (row, result, in-memory state) so the new job starts
  fresh as `waiting` instead of colliding (and `getJobState` no longer returns `completed`
  for the brand-new job).

Note: when the same global `jobs.id` is genuinely duplicated across queues, the losing
duplicate is dropped from disk (it cannot be persisted twice), it still lives in memory
until restart. This is the correct trade-off and is strictly safer than the previous
behavior, which dropped the unrelated jobs instead.

## Bugfixes

Optimization PRAGMAs (e.g. `mmap_size`, which calls `fstat()` on the fd) are applied with
error handling: a transient filesystem `SQLITE_IOERR` during a restart/cleanup race is now
caught and logged instead of propagating out of the `SqliteStorage` constructor (where, in
a deferred context, it surfaced as an "Unhandled error between tests" and tore down CI).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.4](/blog/bunqueue-v2-8-4/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.5) · [Commits since v2.8.4](https://github.com/egeominotti/bunqueue/compare/v2.8.4...v2.8.5) · [Full changelog](/changelog/) · [All posts](/blog/)
