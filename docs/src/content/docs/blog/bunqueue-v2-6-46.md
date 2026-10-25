---
title: "bunqueue v2.6.46"
description: "Fixes 3 bugs. Cloud: resilient WebSocket with ring buffer, cloud: client-side ping heartbeat, cloud: dual-channel failover."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-46.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.46</em></h1>
  <p class="bq-hero-sub">Fixes 3 bugs. Cloud: resilient WebSocket with ring buffer, cloud: client-side ping heartbeat, cloud: dual-channel failover.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.46

```bash title="bun"
bun add bunqueue@2.6.46
```

```bash title="npm"
npm install bunqueue@2.6.46
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Cloud: resilient WebSocket with ring buffer

Events are buffered (max 1000) when WS is disconnected and flushed after `handshake_ack` on reconnect (with 5s fallback timeout). Zero event loss during brief disconnections.

## Cloud: client-side ping heartbeat

Bunqueue sends `{ type: "ping" }` every 10s to the dashboard; if no pong within 5s, closes socket and reconnects. Dead connection detection reduced from ~40s to ~10s.

## Cloud: dual-channel failover

When WS is down, buffered events are embedded in the HTTP snapshot (`snapshot.events`), so the dashboard stays informed even during prolonged disconnections.

## Bugfixes

- **Cloud: double reconnect race**: Pong timeout no longer calls `scheduleReconnect()` directly; delegates to `onclose` to prevent duplicate sockets.
- **Cloud: local socket reference**: All handlers (pong, handshake, commands) use the local `ws` variable, not `this.ws`, preventing replies on stale sockets after reconnect.
- **Cloud: old socket cleanup**: Previous socket is explicitly closed and handlers nulled before creating a new connection.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.45](/blog/bunqueue-v2-6-45/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.46) · [Commits since v2.6.45](https://github.com/egeominotti/bunqueue/compare/v2.6.45...v2.6.46) · [Full changelog](/changelog/) · [All posts](/blog/)
