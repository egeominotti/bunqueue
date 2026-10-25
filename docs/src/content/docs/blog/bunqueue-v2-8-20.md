---
title: "bunqueue v2.8.20"
description: "Fixes 1 bug. Queue.removeAsync() (which backs the BullMQ-style job.remove()) returned before the job was actually removed, on the embedded path (src/client/queue/operations/management.ts): the embedded branch fired…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-20.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-06-17"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.20</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Queue.removeAsync() (which backs the BullMQ-style job.remove()) returned before the job was actually removed, on the embedded path (src/client/queue/operations/management.ts): the embedded branch fired…</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.20

```bash title="bun"
bun add bunqueue@2.8.20
```

```bash title="npm"
npm install bunqueue@2.8.20
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **`Queue.removeAsync()` (which backs the BullMQ-style `job.remove()`) returned before the job was actually removed, on the embedded path** (`src/client/queue/operations/management.ts`): the embedded branch fired `getSharedManager().cancel(id)` as a floating promise and `return`ed immediately, while the TCP branch correctly `await`ed its `Cancel` send. Because `cancel()` performs the removal inside an async write-lock (`cancelJob` → `await withWriteLock(...)`), `await job.remove()` could resolve before the job was gone (and any cancel error was swallowed as an unhandled rejection), inconsistent with the TCP path and a hazard under lock contention. The embedded path now `await`s `cancel()`. Surfaced by the new Biome `noFloatingPromises` lint (the old code was hidden behind a file-level `eslint-disable no-floating-promises`). Deterministic repro via lock contention in `test/repro-removeasync-floating-cancel.test.ts`. The synchronous `remove()` remains intentionally fire-and-forget.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.19](/blog/bunqueue-v2-8-19/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.20) · [Commits since v2.8.19](https://github.com/egeominotti/bunqueue/compare/v2.8.19...v2.8.20) · [Full changelog](/changelog/) · [All posts](/blog/)
