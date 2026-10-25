---
title: "bunqueue v2.6.44"
description: "Fixes 1 bug. Cloud: WebSocket ping/pong heartbeat: Pong responses are now sent regardless of BUNQUEUE_CLOUD_REMOTE_COMMANDS config."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-44.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.44</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Cloud: WebSocket ping/pong heartbeat: Pong responses are now sent regardless of BUNQUEUE_CLOUD_REMOTE_COMMANDS config.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.44

```bash title="bun"
bun add bunqueue@2.6.44
```

```bash title="npm"
npm install bunqueue@2.6.44
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Cloud: WebSocket ping/pong heartbeat**: Pong responses are now sent regardless of `BUNQUEUE_CLOUD_REMOTE_COMMANDS` config. Previously, ping messages were silently dropped when remote commands were disabled, causing the dashboard to disconnect the agent every ~60s as a zombie connection.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.43](/blog/bunqueue-v2-6-43/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.44) · [Commits since v2.6.43](https://github.com/egeominotti/bunqueue/compare/v2.6.43...v2.6.44) · [Full changelog](/changelog/) · [All posts](/blog/)
