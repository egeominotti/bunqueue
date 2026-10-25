---
title: "bunqueue v2.6.65"
description: "MCP operation tracking for Cloud dashboard."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-65.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-22"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.65</em></h1>
  <p class="bq-hero-sub">MCP operation tracking for Cloud dashboard.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.65

```bash title="bun"
bun add bunqueue@2.6.65
```

```bash title="npm"
npm install bunqueue@2.6.65
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## MCP operation tracking for Cloud dashboard

Every MCP tool invocation (73 tools) is now tracked and sent to bunqueue.io as part of the cloud snapshot. Each operation records: tool name, queue affected, timestamp, duration, success/failure, and error message. Data is buffered in a bounded ring buffer (max 200 ops, ~40KB) and drained into each snapshot. In embedded mode, the MCP process creates its own CloudAgent to send telemetry. Zero overhead when cloud is not configured. Includes `mcpOperations` (raw invocation history) and `mcpSummary` (aggregated stats with top tools) fields in `CloudSnapshot`.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.64](/blog/bunqueue-v2-6-64/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.65) · [Commits since v2.6.64](https://github.com/egeominotti/bunqueue/compare/v2.6.64...v2.6.65) · [Full changelog](/changelog/) · [All posts](/blog/)
