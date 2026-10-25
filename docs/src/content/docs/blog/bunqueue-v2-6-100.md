---
title: "bunqueue v2.6.100"
description: "Fixes 2 bugs. Worker deregistration on disconnect: TCP, WebSocket, and SSE disconnect handlers now properly deregister workers when a client disconnects."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-100.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-04-02"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.100</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs. Worker deregistration on disconnect: TCP, WebSocket, and SSE disconnect handlers now properly deregister workers when a client disconnects.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.100

```bash title="bun"
bun add bunqueue@2.6.100
```

```bash title="npm"
npm install bunqueue@2.6.100
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Worker deregistration on disconnect**: TCP, WebSocket, and SSE disconnect handlers now properly deregister workers when a client disconnects. Previously, workers remained registered as "active" after disconnect, causing `skipIfNoWorker` to malfunction (cron jobs would fire even with no workers connected). On reconnect, the worker would immediately pick up the queued job instead of waiting for the next scheduled time (fixes #73).
- **SSE connection cleanup**: SSE `cancel` handler now releases owned jobs back to the queue on disconnect, matching the behavior of TCP and WebSocket handlers.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.99](/blog/bunqueue-v2-6-99/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.100) · [Commits since v2.6.98](https://github.com/egeominotti/bunqueue/compare/v2.6.98...v2.6.100) · [Full changelog](/changelog/) · [All posts](/blog/)
