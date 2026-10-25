---
title: "bunqueue v2.6.47"
description: "Programmatic dataPath for embedded mode, BUNQUEUE_DATA_PATH / BQ_DATA_PATH env vars, cloud: snapshots via WebSocket."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-47.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-20"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.47</em></h1>
  <p class="bq-hero-sub">Programmatic dataPath for embedded mode, BUNQUEUE_DATA_PATH / BQ_DATA_PATH env vars, cloud: snapshots via WebSocket.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.47

```bash title="bun"
bun add bunqueue@2.6.47
```

```bash title="npm"
npm install bunqueue@2.6.47
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Programmatic `dataPath` for embedded mode

Queue and Worker accept `dataPath` option to set the SQLite database path without env vars. Resolves conflicts with apps that use their own `DATA_PATH`. ([#59](https://github.com/egeominotti/bunqueue/issues/59))

## `BUNQUEUE_DATA_PATH` / `BQ_DATA_PATH` env vars

New namespaced env vars for data path configuration. Priority: `BUNQUEUE_DATA_PATH` > `BQ_DATA_PATH` > `DATA_PATH` > `SQLITE_PATH`. Backward compatible.

## Cloud: snapshots via WebSocket

Snapshots are now sent over WS when connected (`{ type: "snapshot", ...data }`), falling back to HTTP POST only when WS is down.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.46](/blog/bunqueue-v2-6-46/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.47) · [Commits since v2.6.46](https://github.com/egeominotti/bunqueue/compare/v2.6.46...v2.6.47) · [Full changelog](/changelog/) · [All posts](/blog/)
