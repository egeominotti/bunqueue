---
title: "bunqueue v2.5.5"
description: "Fixes 1 bug. TCP client auth state corruption: TcpClient.doConnect() set connected = true before authenticate() completed."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-5-5.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-02-26"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.5.5</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. TCP client auth state corruption: TcpClient.doConnect() set connected = true before authenticate() completed.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.5.5

```bash title="bun"
bun add bunqueue@2.5.5
```

```bash title="npm"
npm install bunqueue@2.5.5
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **TCP client auth state corruption**: `TcpClient.doConnect()` set `connected = true` before `authenticate()` completed. If authentication failed, the client remained in a corrupted state (`connected = true` with no valid session), causing subsequent operations to silently fail. Connection state is now set only after successful authentication, with proper cleanup on failure.

## Documentation

- SEO overhaul, keyword-rich titles, optimized descriptions, AI keywords, sitemap priorities

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.5.4](/blog/bunqueue-v2-5-4/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.5.5) · [Commits since v2.5.4](https://github.com/egeominotti/bunqueue/compare/v2.5.4...v2.5.5) · [Full changelog](/changelog/) · [All posts](/blog/)
