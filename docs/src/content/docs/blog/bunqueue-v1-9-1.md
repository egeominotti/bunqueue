---
title: "bunqueue v1.9.1"
description: "Fixes 2 bugs. Two-Phase Stall Detection."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v1-9-1.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-01-29"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v1.9.1</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs. Two-Phase Stall Detection.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v1.9.1

```bash title="bun"
bun add bunqueue@1.9.1
```

```bash title="npm"
npm install bunqueue@1.9.1
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Two-Phase Stall Detection

BullMQ-style stall detection to prevent false positives
- Jobs marked as candidates on first check, confirmed stalled on second
- Prevents requeuing jobs that complete between checks

## More additions

- `stallTimeout` support in client push options
- Advanced health checks for TCP connections

## Changes

- Modularized client code into separate TCP, Worker, Queue, and Sandboxed modules

## Bugfixes

- Defensive checks and cleanup for TCP pool and worker
- Server banner alignment between CLI and main.ts

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v1.9.0](/blog/bunqueue-v1-9-0/) · [Commits since v1.9.0](https://github.com/egeominotti/bunqueue/compare/v1.9.0...v1.9.1) · [Full changelog](/changelog/) · [All posts](/blog/)
