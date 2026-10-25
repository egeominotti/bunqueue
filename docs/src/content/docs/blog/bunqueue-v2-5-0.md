---
title: "bunqueue v2.5.0"
description: "AI agent documentation and use cases."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-5-0.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-02-21"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.5.0</em></h1>
  <p class="bq-hero-sub">AI agent documentation and use cases.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.5.0

```bash title="bun"
bun add bunqueue@2.5.0
```

```bash title="npm"
npm install bunqueue@2.5.0
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

- TCP mode for MCP server, connect to remote bunqueue server via `BUNQUEUE_MODE=tcp`
- AI agent documentation and use cases
- MCP configuration guides for Claude Desktop, Claude Code, Cursor, and Windsurf

## Changes

- **MCP server rewrite**: Upgraded from custom implementation to official `@modelcontextprotocol/sdk` (v1.26.0) for full protocol compliance
- **66 tools** organized across 10 domain-specific files (jobTools, jobMgmtTools, consumptionTools, queueTools, dlqTools, cronTools, rateLimitTools, webhookTools, workerMgmtTools, monitoringTools)
- **5 MCP resources** for read-only AI context (stats, queues, crons, workers, webhooks)
- **Dual-mode backend**: Embedded (direct SQLite) and TCP (remote server) via `McpBackend` adapter interface

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.4.8](/blog/bunqueue-v2-4-8/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.5.0) · [Commits since v2.4.8](https://github.com/egeominotti/bunqueue/compare/v2.4.8...v2.5.0) · [Full changelog](/changelog/) · [All posts](/blog/)
