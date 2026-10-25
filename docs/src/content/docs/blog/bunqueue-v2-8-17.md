---
title: "bunqueue v2.8.17"
description: "Fixes 1 bug. Retrying a job that reached failed through the lock-expiry path failed with UNIQUE constraint failed: jobs.id (src/application/lockManager.ts): handleMaxStallsExceeded moved the job to the DLQ using only in-memory state…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-17.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-06-16"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.17</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Retrying a job that reached failed through the lock-expiry path failed with UNIQUE constraint failed: jobs.id (src/application/lockManager.ts): handleMaxStallsExceeded moved the job to the DLQ using only in-memory state…</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.17

```bash title="bun"
bun add bunqueue@2.8.17
```

```bash title="npm"
npm install bunqueue@2.8.17
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Retrying a job that reached `failed` through the lock-expiry path failed with `UNIQUE constraint failed: jobs.id`** (`src/application/lockManager.ts`): `handleMaxStallsExceeded` moved the job to the DLQ using only in-memory state (`shard.addToDlq` + `jobIndex.set`). Unlike its three sibling paths, `ack.moveFailedJobToDlq` (max attempts), `stallDetection.moveStalliedJobToDlq` (heartbeat stall), and the startup recovery in `backgroundTasks`, it never called `storage.saveDlqEntry(entry)` nor `storage.deleteJob(jobId)`. So the `jobs` row survived in SQLite as an orphan (state `active`) and the DLQ entry lived only in memory. On retry, `dlqManager.retryDlqJob` re-INSERTs the job with its original id via the plain `INSERT INTO jobs` statement (not `INSERT OR REPLACE` like `insertResult`/`insertCron`), and the surviving orphan row raised the UNIQUE violation, failing the retry; a restart in that window also re-recovered the stale `active` row. The lock-expiry DLQ move now persists like its siblings (capture the `DlqEntry`, then `saveDlqEntry` + `deleteJob`), restoring the single-table-residency invariant. `deleteJob` also evicts the id from the write buffer, so a non-durable job cannot later flush a stale INSERT and re-orphan.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.16](/blog/bunqueue-v2-8-16/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.17) · [Commits since v2.8.16](https://github.com/egeominotti/bunqueue/compare/v2.8.16...v2.8.17) · [Full changelog](/changelog/) · [All posts](/blog/)
