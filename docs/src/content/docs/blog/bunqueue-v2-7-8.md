---
title: "bunqueue v2.7.8"
description: "Fixes 2 bugs. cleanAsync() silently returned [] for completed/failed/wait (Issue #84), cleanQueue() only handled 'waiting' and 'delayed' state filters; all other states fell through to a no-op, leaving job data in SQLite."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-7-8.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-04-20"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.7.8</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs. cleanAsync() silently returned [] for completed/failed/wait (Issue #84), cleanQueue() only handled 'waiting' and 'delayed' state filters; all other states fell through to a no-op, leaving job data in SQLite.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.7.8

```bash title="bun"
bun add bunqueue@2.7.8
```

```bash title="npm"
npm install bunqueue@2.7.8
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Changes

- `cleanAsync('active')` is intentionally unsupported: cleaning in-flight jobs races with the worker's ack path and leaks concurrency/uniqueKey/groupId slots. Use `fail(jobId)` or `cancelJob(jobId)` to terminate an active job safely.

## Bugfixes

- **`cleanAsync()` silently returned `[]` for `completed`/`failed`/`wait`** (Issue #84), `cleanQueue()` only handled `'waiting'` and `'delayed'` state filters; all other states fell through to a no-op, leaving job data in SQLite. Rewritten to support `completed`, `failed`, and waiting-like states (`wait`/`waiting`/`delayed`/`prioritized`/`paused`), with per-state helpers (`cleanWaitingLike`, `cleanCompleted`, `cleanFailed`) that remove entries from `jobIndex`, `completedJobs`/`completedJobsData`, DLQ, `jobResults`/`jobLogs`, and SQLite (`jobs` + `dlq` tables). `'wait'` is now normalized to `'waiting'` (BullMQ alias).
- **`cleanAsync()` SQLite write failures corrupted state**: `storage.deleteJob`/`deleteDlqEntry` inside cleanup loops now use swallow-and-continue wrappers so one SQLite error (e.g. `SQLITE_FULL`) does not leave the in-memory state inconsistent with disk.

## Tests

- 4 new regression tests in `test/client-queue-operations.test.ts` (completed cleanup, failed cleanup, `'wait'` alias, grace-period honored for completed).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.7.7](/blog/bunqueue-v2-7-7/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.7.8) · [Commits since v2.7.7](https://github.com/egeominotti/bunqueue/compare/v2.7.7...v2.7.8) · [Full changelog](/changelog/) · [All posts](/blog/)
