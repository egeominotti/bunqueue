---
title: "bunqueue v2.7.10"
description: "Fixes 1 bug and ships 1 addition. clean() left orphan rows in job_results table (Issue #84, follow-up from @jdorner), storage.deleteJob() executed only DELETE FROM jobs, so cleaned completed jobs' result rows persisted forever in…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-7-10.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.7.10</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug and ships 1 addition. clean() left orphan rows in job_results table (Issue #84, follow-up from @jdorner), storage.deleteJob() executed only DELETE FROM jobs, so cleaned completed jobs' result rows persisted forever in…</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.7.10

```bash title="bun"
bun add bunqueue@2.7.10
```

```bash title="npm"
npm install bunqueue@2.7.10
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

- `deleteJobResult` prepared statement in `src/infrastructure/persistence/statements.ts`.

## Bugfixes

- **`clean()` left orphan rows in `job_results` table** (Issue #84, follow-up from @jdorner), `storage.deleteJob()` executed only `DELETE FROM jobs`, so cleaned completed jobs' result rows persisted forever in `job_results`. `deleteJob()` now runs both `DELETE FROM jobs` and `DELETE FROM job_results WHERE job_id = ?` inside a single `db.transaction(...)` block, atomically cascading the removal. DLQ is intentionally not cascaded here: `moveFailedJobToDlq()` relies on `saveDlqEntry` + `deleteJob` preserving the DLQ row. Callers that clean DLQ (e.g. `cleanFailed`) explicitly call `deleteDlqEntry` beforehand.

## Tests

- 2 regression tests in `test/client-queue-operations.test.ts`: clean('completed') leaves no orphan `job_results` rows; clean('failed') leaves no orphan rows in jobs/dlq/job_results.
- Updated `test/sqlite-serializer.test.ts` statement count (13 → 14).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.7.9](/blog/bunqueue-v2-7-9/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.7.10) · [Commits since v2.7.9](https://github.com/egeominotti/bunqueue/compare/v2.7.9...v2.7.10) · [Full changelog](/changelog/) · [All posts](/blog/)
