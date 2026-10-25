---
title: "bunqueue v2.6.114"
description: "Fixes 1 bug. Worker 'ready' event never fires with chained listener: Worker.run() was emitting 'ready' synchronously inside the constructor (when autorun: true, the default), so listeners attached via the chained pattern new…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-114.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-04-07"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.114</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Worker 'ready' event never fires with chained listener: Worker.run() was emitting 'ready' synchronously inside the constructor (when autorun: true, the default), so listeners attached via the chained pattern new…</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.114

```bash title="bun"
bun add bunqueue@2.6.114
```

```bash title="npm"
npm install bunqueue@2.6.114
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Worker `'ready'` event never fires with chained listener**: `Worker.run()` was emitting `'ready'` synchronously inside the constructor (when `autorun: true`, the default), so listeners attached via the chained pattern `new Worker(...).on('ready', ...)` were registered too late and missed the event. The emit is now deferred via `queueMicrotask`, so listeners attached synchronously after construction still receive `'ready'`. Fixes [#76](https://github.com/egeominotti/bunqueue/issues/76).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.113](/blog/bunqueue-v2-6-113/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.114) · [Commits since v2.6.113](https://github.com/egeominotti/bunqueue/compare/v2.6.113...v2.6.114) · [Full changelog](/changelog/) · [All posts](/blog/)
