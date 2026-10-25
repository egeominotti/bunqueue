---
title: "bunqueue v2.8.28"
description: "bunqueue 2.8.28 release notes."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-28.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-09"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.28</em></h1>
  <p class="bq-hero-sub">bunqueue 2.8.28 release notes.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.28

```bash title="bun"
bun add bunqueue@2.8.28
```

```bash title="npm"
npm install bunqueue@2.8.28
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

The #97 fix (2.8.17) added `saveDlqEntry` + `deleteJob` persistence to `handleMaxStallsExceeded`, but the periodic lock sweep, the **only** production caller of `checkExpiredLocks`, builds its context with a file-local `getLockContext` that omitted `storage`. Both persistence calls silently no-op'd through optional chaining (`ctx.storage?.…` with `storage: undefined`), so a job failed via lock expiry (frozen worker + `maxStalls` reached) left an orphan `state="active"` row in the `jobs` table while its DLQ entry existed only in memory. A restart between the failure and a retry lost the real DLQ entry (failure reason, timestamps, attempt history); startup recovery could only fabricate a generic stalled entry from the orphan row. This is why #97 kept re-reproducing across 2.8.18 → 2.8.27 despite the mover itself being correct, and it also no-op'd the orphan-row cleanup for expired `preventOverlap` cron jobs on the same path.

Fix: `getLockContext` now carries `storage: ctx.storage` (one line, exactly as diagnosed in the issue report, which traced it to the line and validated the patch RED→GREEN against the installed dist; thank you). The regression test goes through the real background-interval path and asserts **SQLite residency** (the `dlq` row exists, the `jobs` row is gone) rather than the in-memory view that had masked the bug in the existing lock-expiration tests.

## Bugfixes

Making `storage` a **required (nullable)** field on `LockContext`/`DlqContext`/`QueueControlContext`, the reporter's third suggestion, so a forgotten dependency is a compile error instead of silent data loss, immediately surfaced a second instance of the same class: the embedded client's `getDlqContext` (`src/client/queue/helpers.ts`) also omitted `storage`. Embedded `queue.retryDlqByFilter(filter)` therefore re-queued jobs in memory only: the `dlq` row was never deleted (the job resurrected into the DLQ on restart) and the re-queued `jobs` row was never inserted (the retried job did not survive a restart). Both persistence calls now execute; regression test asserts SQLite residency through the public embedded API.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.27](/blog/bunqueue-v2-8-27/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.28) · [Commits since v2.8.27](https://github.com/egeominotti/bunqueue/compare/v2.8.27...v2.8.28) · [Full changelog](/changelog/) · [All posts](/blog/)
