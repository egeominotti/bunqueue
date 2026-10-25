---
title: "bunqueue v2.5.1"
description: "Fixes 3 bugs and ships 2 additions. MCP error handling: All 66 tool handlers now wrapped with withErrorHandler that catches backend exceptions and returns structured { error: \"message\" } responses with isError: true instead of raw stack…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-5-1.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-02-23"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.5.1</em></h1>
  <p class="bq-hero-sub">Fixes 3 bugs and ships 2 additions. MCP error handling: All 66 tool handlers now wrapped with withErrorHandler that catches backend exceptions and returns structured { error: "message" } responses with isError: true instead of raw stack…</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.5.1

```bash title="bun"
bun add bunqueue@2.5.1
```

```bash title="npm"
npm install bunqueue@2.5.1
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

- `src/mcp/tools/withErrorHandler.ts`, Reusable error boundary for MCP tool handlers
- 39 new MCP backend tests (75 total), webhooks, worker management, monitoring, batch operations, heartbeat, progress, full lifecycle

## Bugfixes

- **MCP error handling**: All 66 tool handlers now wrapped with `withErrorHandler` that catches backend exceptions and returns structured `{ error: "message" }` responses with `isError: true` instead of raw stack traces
- **MCP TCP connection**: `createBackend()` is now async and properly awaits TCP connection. Previously used fire-and-forget (`void backend.connect()`) which silently swallowed connection failures
- **MCP not-found responses**: `bunqueue_get_job`, `bunqueue_get_job_by_custom_id`, `bunqueue_get_progress`, and `bunqueue_get_cron` now return `isError: true` when resource is not found

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.5.0](/blog/bunqueue-v2-5-0/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.5.1) · [Commits since v2.5.0](https://github.com/egeominotti/bunqueue/compare/v2.5.0...v2.5.1) · [Full changelog](/changelog/) · [All posts](/blog/)
