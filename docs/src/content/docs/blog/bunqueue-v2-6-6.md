---
title: "bunqueue v2.6.6"
description: "Fixes 2 bugs. Parent-child flow race condition: Resolved race where concurrent ack/fail operations on parent-child flows could cause inconsistent state."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-6.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-07"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.6</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs. Parent-child flow race condition: Resolved race where concurrent ack/fail operations on parent-child flows could cause inconsistent state.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.6

```bash title="bun"
bun add bunqueue@2.6.6
```

```bash title="npm"
npm install bunqueue@2.6.6
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Parent-child flow race condition**: Resolved race where concurrent ack/fail operations on parent-child flows could cause inconsistent state. ([#31](https://github.com/egeominotti/bunqueue/issues/31))
- **Embedded Worker heartbeats**: Fixed embedded Worker heartbeat mechanism not properly keeping jobs alive during long processing. ([#32](https://github.com/egeominotti/bunqueue/issues/32))

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.5](/blog/bunqueue-v2-6-5/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.6) · [Commits since v2.6.5](https://github.com/egeominotti/bunqueue/compare/v2.6.5...v2.6.6) · [Full changelog](/changelog/) · [All posts](/blog/)
