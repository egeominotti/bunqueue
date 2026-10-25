---
title: "bunqueue v2.7.20"
description: "Fixes 3 bugs. drain() left stale rows in SQLite (embedded): queue.drain() cleared the in-memory index and counts but never deleted the SQLite rows, so drained jobs resurrected via getJobState/getJob/getWaiting/getJobs and would reload on…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-7-20.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-05-31"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.7.20</em></h1>
  <p class="bq-hero-sub">Fixes 3 bugs. drain() left stale rows in SQLite (embedded): queue.drain() cleared the in-memory index and counts but never deleted the SQLite rows, so drained jobs resurrected via getJobState/getJob/getWaiting/getJobs and would reload on…</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.7.20

```bash title="bun"
bun add bunqueue@2.7.20
```

```bash title="npm"
npm install bunqueue@2.7.20
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

A live end-to-end pass exercised every feature locally (18 areas, ~317 checks); all 2.7.19 fixes held, and three pre-existing bugs were found and fixed. Each ships a reproducing test (`test/audit-*.test.ts`).

- **`drain()` left stale rows in SQLite (embedded)**: `queue.drain()` cleared the in-memory index and counts but never deleted the SQLite rows, so drained jobs resurrected via `getJobState`/`getJob`/`getWaiting`/`getJobs` and would reload on restart. `drainQueue` now deletes each drained job's row (via the same `safeDeleteJob` path `clean`/`obliterate` use, which also clears any pending write-buffer entry). Only waiting/delayed/prioritized jobs are drained (active jobs untouched). (`application/operations/queueControl.ts`)
- **Workflow `waitFor` timeout ran saga compensation twice**: on a `waitFor` timeout, `runWaitFor()` compensated and then threw a plain `Error`, which `processStep`'s catch re-compensated. It now throws the `WaitForSignalError` sentinel (and emits `workflow:failed` once) so compensation runs exactly once. The signal-success path, normal step-failure path and `forEach` compensation are unchanged. (`client/workflow/executor.ts`)
- **Auto-batch `add()` swallowed server rejections**: when the server rejected a `PUSHB` (e.g. auth failure), `addBulk` returned `[]` and the auto-batcher resolved callers with `undefined` instead of throwing, so a batched `queue.add()` silently appeared to succeed (the server correctly persisted nothing, this was an error-propagation defect, not an auth bypass). `addBulk` now throws on `!response.ok` (mirroring the single-`PUSH` path), so all batched callers reject; an OK-but-empty response still returns `[]`. (`client/queue/operations/add.ts`)

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.7.19](/blog/bunqueue-v2-7-19/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.7.20) · [Commits since v2.7.19](https://github.com/egeominotti/bunqueue/compare/v2.7.19...v2.7.20) · [Full changelog](/changelog/) · [All posts](/blog/)
