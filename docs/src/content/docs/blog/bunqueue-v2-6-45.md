---
title: "bunqueue v2.6.45"
description: "Fixes 1 bug. Cloud: prev and delay fields in WebSocket events."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-45.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-20"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.45</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Cloud: prev and delay fields in WebSocket events.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.45

```bash title="bun"
bun add bunqueue@2.6.45
```

```bash title="npm"
npm install bunqueue@2.6.45
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Cloud: `prev` and `delay` fields in WebSocket events

CloudEvent now forwards all JobEvent fields: `prev` (previous state on removed/retried) and `delay` (ms for delayed jobs).

## Bugfixes

- **Cloud: WebSocket binary frame handling**: Ping/pong and command messages now handle both text and binary WebSocket frames (ArrayBuffer/Buffer), preventing silent parse failures behind Cloudflare.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.44](/blog/bunqueue-v2-6-44/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.45) · [Commits since v2.6.44](https://github.com/egeominotti/bunqueue/compare/v2.6.44...v2.6.45) · [Full changelog](/changelog/) · [All posts](/blog/)
