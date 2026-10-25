---
title: "bunqueue v2.4.0"
description: "Auto-batching for queue.add() over TCP, 306 new tests."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-4-0.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-02-11"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.4.0</em></h1>
  <p class="bq-hero-sub">Auto-batching for queue.add() over TCP, 306 new tests.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.4.0

```bash title="bun"
bun add bunqueue@2.4.0
```

```bash title="npm"
npm install bunqueue@2.4.0
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Auto-batching for `queue.add()` over TCP

Transparently batches concurrent `add()` calls into `PUSHB` commands
- Zero overhead for sequential `await` usage (flush immediately when idle)
- ~3x speedup for concurrent adds (buffers during in-flight flush)
- Configurable: `autoBatch: { maxSize: 50, maxDelayMs: 5 }` (defaults)
- Durable jobs bypass the batcher (sent as individual PUSH)
- Disable with `autoBatch: { enabled: false }`

## 306 new tests

Covering previously untested modules

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.3.1](/blog/bunqueue-v2-3-1/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.4.0) · [Commits since v2.3.1](https://github.com/egeominotti/bunqueue/compare/v2.3.1...v2.4.0) · [Full changelog](/changelog/) · [All posts](/blog/)
