---
title: "bunqueue v2.8.6"
description: "Fixes 4 bugs. Command timeouts now drive reconnection."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-6.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-06-07"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.6</em></h1>
  <p class="bq-hero-sub">Fixes 4 bugs. Command timeouts now drive reconnection.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.6

```bash title="bun"
bun add bunqueue@2.8.6
```

```bash title="npm"
npm install bunqueue@2.8.6
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

A TCP worker whose socket goes **half-open**, the peer vanishes with no FIN/RST
(suspended host, NAT/load-balancer silently dropping an idle connection), had only
**one** path back to health: the periodic health-check ping. Every PULL the worker
issued timed out (`Command timeout`), `consecutiveErrors` climbed, jobs piled up with
`active=0`, and none of those command timeouts ever concluded the link was dead. With
default settings the dead socket wasn't torn down until the ping path had failed
`maxPingFailures` times, roughly **two minutes**, and if the ping was disabled
(`pingInterval: 0`) or slower than real traffic, the worker could stall **indefinitely**.

Fixes:

- **Command timeouts now drive reconnection.** `maxCommandTimeouts` consecutive
  in-flight command timeouts with no intervening success (default 3, `0` disables) now
  conclude the connection is dead and trigger the existing reconnect/backoff path.
  Recovery no longer depends solely on the health-check ping. The counter resets on any
  successful response, so it only fires on a sustained run of timeouts, the signature of
  a dead/half-open socket. Configurable via `connection.maxCommandTimeouts`.
- **`forceReconnect()` now settles in-flight commands immediately.** Previously the
  per-command timers kept ticking after the socket was torn down and could fire against
  the freshly re-established connection (a reconnect storm); it also made awaiting callers
  (e.g. a worker's PULL) wait out the full `commandTimeout` on a corpse. They are now
  rejected at once with `Connection lost`.
- **`SO_KEEPALIVE` enabled** on client sockets so the OS surfaces a dead peer on its own
  rather than waiting out `tcp_retries2` (~15 min). Best-effort, platform-dependent.
- Hardened `socket.end()` in the reconnect path against throwing on an already-dead socket.

Note: with a default `commandTimeout` of 30s, timeout-based detection is still inherently
coarse (each timeout is 30s). For fast recovery, lower `connection.pingInterval` /
`connection.commandTimeout`; the new path also makes recovery work when the ping is off.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.5](/blog/bunqueue-v2-8-5/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.6) · [Commits since v2.8.5](https://github.com/egeominotti/bunqueue/compare/v2.8.5...v2.8.6) · [Full changelog](/changelog/) · [All posts](/blog/)
