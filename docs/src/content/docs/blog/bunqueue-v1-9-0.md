---
title: "bunqueue v1.9.0"
description: "TCP Client."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v1-9-0.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-01-28"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v1.9.0</em></h1>
  <p class="bq-hero-sub">TCP Client.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v1.9.0

```bash title="bun"
bun add bunqueue@1.9.0
```

```bash title="npm"
npm install bunqueue@1.9.0
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## TCP Client

High-performance TCP client for remote server connections
- Connection pooling with configurable pool size
- Heartbeat keepalive mechanism
- Batch pull/ACK operations (PULLB, ACKB with results)
- Long polling support
- Ping/pong health checks

## More additions

- 4.7x faster push throughput with optimized TCP client

## Changes

- Connection pool enabled by default for TCP clients
- Improved ESLint compliance across TCP client code

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v1.6.8](/blog/bunqueue-v1-6-8/) · [Commits since v1.4.0](https://github.com/egeominotti/bunqueue/compare/v1.4.0...v1.9.0) · [Full changelog](/changelog/) · [All posts](/blog/)
