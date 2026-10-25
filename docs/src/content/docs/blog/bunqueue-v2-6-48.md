---
title: "bunqueue v2.6.48"
description: "Fixes 2 bugs. Cloud: auth via HTTP upgrade headers: WebSocket authentication now uses Authorization, X-Instance-Id, and X-Remote-Commands headers on the upgrade request (Bun-specific)."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-48.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.48</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs. Cloud: auth via HTTP upgrade headers: WebSocket authentication now uses Authorization, X-Instance-Id, and X-Remote-Commands headers on the upgrade request (Bun-specific).</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.48

```bash title="bun"
bun add bunqueue@2.6.48
```

```bash title="npm"
npm install bunqueue@2.6.48
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Changes

- **Cloud: auth via HTTP upgrade headers**: WebSocket authentication now uses `Authorization`, `X-Instance-Id`, and `X-Remote-Commands` headers on the upgrade request (Bun-specific). Eliminates the JSON handshake message and the 100ms delay workaround.
- **Cloud: removed client-side ping**: Client-side ping (every 10s) was causing false disconnects (code 4000). Keepalive now relies solely on server-side ping (25s) with bunqueue responding pong.

## Bugfixes

- **Cloud: duplicate reconnect guard**: `scheduleReconnect()` now prevents multiple concurrent reconnect timers.
- **Cloud: `onclose` logs at `info` level**: Previously `debug`, making reconnect failures invisible in production logs.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.47](/blog/bunqueue-v2-6-47/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.48) · [Commits since v2.6.47](https://github.com/egeominotti/bunqueue/compare/v2.6.47...v2.6.48) · [Full changelog](/changelog/) · [All posts](/blog/)
