---
title: "bunqueue v2.6.101"
description: "Fixes 1 bug. WebSocket rate limiter leak: WebSocket disconnect handler was not calling removeClient() on the rate limiter, causing per-client rate limiter state to accumulate indefinitely."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-101.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.101</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. WebSocket rate limiter leak: WebSocket disconnect handler was not calling removeClient() on the rate limiter, causing per-client rate limiter state to accumulate indefinitely.</p>
</div>

#### To install bunqueue v2.6.101

```bash title="bun"
bun add bunqueue@2.6.101
```

```bash title="npm"
npm install bunqueue@2.6.101
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **WebSocket rate limiter leak**: WebSocket disconnect handler was not calling `removeClient()` on the rate limiter, causing per-client rate limiter state to accumulate indefinitely. TCP already did this correctly; now WebSocket matches.

---

[← bunqueue v2.6.100](/blog/bunqueue-v2-6-100/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.101) · [Commits since v2.6.100](https://github.com/egeominotti/bunqueue/compare/v2.6.100...v2.6.101) · [Full changelog](/changelog/) · [All posts](/blog/)
