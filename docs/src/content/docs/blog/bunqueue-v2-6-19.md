---
title: "bunqueue v2.6.19"
description: "WebSocket idle timeout (ping/pong), webSocket max payload limit."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-19.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-14"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.19</em></h1>
  <p class="bq-hero-sub">WebSocket idle timeout (ping/pong), webSocket max payload limit.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.19

```bash title="bun"
bun add bunqueue@2.6.19
```

```bash title="npm"
npm install bunqueue@2.6.19
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## WebSocket idle timeout (ping/pong)

Set `idleTimeout: 120` on the WebSocket server. Bun automatically sends ping frames and closes connections that don't respond with pong within 120 seconds. Dead clients (crash, network drop, kill -9) are now detected and cleaned up automatically instead of leaking in the clients Map forever.

## WebSocket max payload limit

Set `maxPayloadLength: 1MB`. Prevents memory exhaustion from oversized messages.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.18](/blog/bunqueue-v2-6-18/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.19) · [Commits since v2.6.17](https://github.com/egeominotti/bunqueue/compare/v2.6.17...v2.6.19) · [Full changelog](/changelog/) · [All posts](/blog/)
