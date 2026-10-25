---
title: "bunqueue v2.5.2"
description: "Fixes 4 bugs. Tests for PUSHB deduplication (same-batch and cross-batch), test for ping response structure validation, E2E TCP deduplication test script (scripts/tcp/test-dedup-tcp.ts)."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-5-2.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-02-24"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.5.2</em></h1>
  <p class="bq-hero-sub">Fixes 4 bugs. Tests for PUSHB deduplication (same-batch and cross-batch), test for ping response structure validation, E2E TCP deduplication test script (scripts/tcp/test-dedup-tcp.ts).</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.5.2

```bash title="bun"
bun add bunqueue@2.5.2
```

```bash title="npm"
npm install bunqueue@2.5.2
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

- Tests for PUSHB deduplication (same-batch and cross-batch)
- Tests for CLI server argument re-injection (`--host`, `-p`, `--host=VALUE`, `--port=VALUE`)
- Test for ping response structure validation
- E2E TCP deduplication test script (`scripts/tcp/test-dedup-tcp.ts`)

## Bugfixes

- **TCP deduplication**: `jobId` deduplication now works correctly in TCP mode. The auto-batcher was sending `jobId` instead of `customId` in PUSHB commands, causing the server to skip deduplication for all batched operations ([#10](https://github.com/egeominotti/bunqueue/issues/10))
- **CLI `--host` and `-p` flags**: `bunqueue start --host 127.0.0.1 -p 6666` now correctly binds to the specified host and port. Previously, `parseGlobalOptions()` consumed these flags as global options, removing them before the server could use them ([#9](https://github.com/egeominotti/bunqueue/issues/9))
- **Docker healthcheck**: Changed healthcheck URL from `localhost` to `127.0.0.1` to avoid IPv6 resolution issues in Alpine containers ([#7](https://github.com/egeominotti/bunqueue/issues/7))
- **TCP ping health check**: Fixed ping response parsing from `response.pong` to `response.data.pong` matching the actual server response structure ([#5](https://github.com/egeominotti/bunqueue/issues/5))

## Documentation

- Updated deployment guide healthcheck example (`localhost` → `127.0.0.1`)
- Clarified that `jobId` deduplication works in both embedded and TCP modes
- Added `--host` flag example to CLI start command reference

## Thanks to 2 contributors!

- [@egeominotti](https://github.com/egeominotti)
- [@motopods](https://github.com/motopods)

---

[← bunqueue v2.5.1](/blog/bunqueue-v2-5-1/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.5.2) · [Commits since v2.5.1](https://github.com/egeominotti/bunqueue/compare/v2.5.1...v2.5.2) · [Full changelog](/changelog/) · [All posts](/blog/)
