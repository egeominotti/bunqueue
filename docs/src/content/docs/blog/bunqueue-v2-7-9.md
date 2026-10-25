---
title: "bunqueue v2.7.9"
description: "Fixes 2 bugs and ships 1 addition. clean()/cleanAsync() returned array of empty strings (Issue #84, follow-up from @jdorner), Previously returned new Array(count).fill(''), so the result length was correct but the IDs were empty."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-7-9.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.7.9</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs and ships 1 addition. clean()/cleanAsync() returned array of empty strings (Issue #84, follow-up from @jdorner), Previously returned new Array(count).fill(''), so the result length was correct but the IDs were empty.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.7.9

```bash title="bun"
bun add bunqueue@2.7.9
```

```bash title="npm"
npm install bunqueue@2.7.9
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

- SQLite migration 11: `idx_jobs_completed_order` index on `(completed_at DESC) WHERE state = 'completed'` for O(log n) recovery ordering.

## Protocol

- `CountResponse` now carries an optional `ids?: string[]` field, populated by the `Clean` handler so TCP clients receive the removed job IDs (previously only the count).

## Bugfixes

- **`clean()`/`cleanAsync()` returned array of empty strings** (Issue #84, follow-up from @jdorner), Previously returned `new Array(count).fill('')`, so the result length was correct but the IDs were empty. Now returns the actual `JobId[]` of removed jobs end-to-end (queueControl → queueManager → TCP handler → MCP adapter → cloud commands → client).
- **Completed jobs lost after server restart** (Issue #84, follow-up from @jdorner), `recover()` did not repopulate `jobIndex`/`completedJobs`/`completedJobsData` for completed jobs in SQLite, so `cleanAsync('completed')` after a restart found nothing to clean and `stats.completed` under-reported. Added Phase 3 recovery: loads up to `maxCompletedJobs` (default 50k) jobs ordered by `completed_at DESC`, populates in-memory indexes. Does not touch `customIdMap` (preserves pending-job dedup).

## Tests

- 2 new regression tests in `test/client-queue-operations.test.ts` (actual-ids returned, post-restart cleanup).
- Updated 8 obsolete tests that asserted `clean()` returned a number.
- Updated `stress.test.ts` persistence-under-load expectation from 100 → 200 (completed jobs now survive restart, so cumulative total is correct).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.7.8](/blog/bunqueue-v2-7-8/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.7.9) · [Commits since v2.7.8](https://github.com/egeominotti/bunqueue/compare/v2.7.8...v2.7.9) · [Full changelog](/changelog/) · [All posts](/blog/)
