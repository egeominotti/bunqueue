---
title: "bunqueue v2.6.17"
description: "Fixes 1 bug. Memory leak in HTTP client tracking: Every HTTP PULL+ACK cycle created an orphaned entry in the clientJobs Map that was never cleaned up."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-17.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.17</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Memory leak in HTTP client tracking: Every HTTP PULL+ACK cycle created an orphaned entry in the clientJobs Map that was never cleaned up.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.17

```bash title="bun"
bun add bunqueue@2.6.17
```

```bash title="npm"
npm install bunqueue@2.6.17
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Memory leak in HTTP client tracking**: Every HTTP PULL+ACK cycle created an orphaned entry in the `clientJobs` Map that was never cleaned up. Over time this grew unbounded. Fix: HTTP requests no longer set `clientId` (stateless). Job ownership tracking only applies to persistent connections (TCP/WebSocket). Orphaned HTTP jobs are handled by stall detection.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.16](/blog/bunqueue-v2-6-16/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.17) · [Commits since v2.6.16](https://github.com/egeominotti/bunqueue/compare/v2.6.16...v2.6.17) · [Full changelog](/changelog/) · [All posts](/blog/)
