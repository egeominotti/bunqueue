---
title: "bunqueue v2.5.8"
description: "Fixes 2 bugs. FlowJobData type, CLI env var auth."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-5-8.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-02"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.5.8</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs. FlowJobData type, CLI env var auth.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.5.8

```bash title="bun"
bun add bunqueue@2.5.8
```

```bash title="npm"
npm install bunqueue@2.5.8
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## `FlowJobData` type

New exported interface for flow-injected fields (`__flowParentId`, `__flowParentIds`, `__parentId`, `__parentQueue`, `__childrenIds`). `Processor<T, R>` now intersects `T` with `FlowJobData` for automatic IntelliSense in Worker callbacks. ([#18](https://github.com/egeominotti/bunqueue/issues/18))

## CLI env var auth

CLI now reads `BQ_TOKEN` / `BUNQUEUE_TOKEN` environment variables as fallback when `--token` is not provided. Priority: `--token` flag > `BQ_TOKEN` > `BUNQUEUE_TOKEN`. ([#13](https://github.com/egeominotti/bunqueue/issues/13))

## Bugfixes

- **Repeat job updateData**: `updateData()` now propagates to the next repeat execution. Previously, calling `updateData()` on a completed repeated job silently failed because the job was removed from the index. A repeat chain now tracks successor job IDs so updates reach the next scheduled execution. ([#16](https://github.com/egeominotti/bunqueue/issues/16))
- **Worker event IntelliSense**: Worker now has typed `on()` and `once()` overloads for all 10 events (`ready`, `active`, `completed`, `failed`, `progress`, `stalled`, `drained`, `error`, `cancelled`, `closed`), providing full TypeScript autocomplete. ([#15](https://github.com/egeominotti/bunqueue/issues/15))

## Documentation

- Updated Worker guide with typed event reference table
- Updated Flow guide with `FlowJobData` type documentation
- Updated Queue guide with `updateData()` for repeatable jobs
- Updated CLI guide and env vars guide with `BQ_TOKEN` / `BUNQUEUE_TOKEN`

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.5.7](/blog/bunqueue-v2-5-7/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.5.8) · [Commits since v2.5.7](https://github.com/egeominotti/bunqueue/compare/v2.5.7...v2.5.8) · [Full changelog](/changelog/) · [All posts](/blog/)
