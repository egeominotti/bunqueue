---
title: "bunqueue v2.6.26"
description: "Enterprise-grade SSE, enterprise-grade WebSocket."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-26.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-15"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.26</em></h1>
  <p class="bq-hero-sub">Enterprise-grade SSE, enterprise-grade WebSocket.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.26

```bash title="bun"
bun add bunqueue@2.6.26
```

```bash title="npm"
npm install bunqueue@2.6.26
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Enterprise-grade SSE

Event IDs for client-side deduplication, Last-Event-ID resume with ring buffer (1000 events), heartbeat keepalive (30s), retry field (3s auto-reconnect), connection limit (1000 max with 503 rejection).

## Enterprise-grade WebSocket

Backpressure detection via getBufferedAmount() (1MB threshold), dead client cleanup in emit/broadcast, connection limit (1000 max), dropped message counter for observability.

## Documentation

- **Worker options**: Documented 8 missing options: limiter, lockDuration, maxStalledCount, skipStalledCheck, skipLockRenewal, drainDelay, removeOnComplete, removeOnFail.
- **FlowProducer BullMQ v5 API**: Documented add(), addBulk(), getFlow() methods with FlowJob/JobNode interfaces.
- **Lifecycle functions**: Documented shutdownManager(), closeSharedTcpClient(), closeAllSharedPools().
- **Environment variables**: Added BUNQUEUE_MODE, BUNQUEUE_HOST, BUNQUEUE_PORT to env-vars reference.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.25](/blog/bunqueue-v2-6-25/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.26) · [Commits since v2.6.25](https://github.com/egeominotti/bunqueue/compare/v2.6.25...v2.6.26) · [Full changelog](/changelog/) · [All posts](/blog/)
