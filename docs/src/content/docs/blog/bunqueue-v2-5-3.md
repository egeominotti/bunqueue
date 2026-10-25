---
title: "bunqueue v2.5.3"
description: "Fixes 5 bugs. 3 MCP Prompts."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-5-3.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.5.3</em></h1>
  <p class="bq-hero-sub">Fixes 5 bugs. 3 MCP Prompts.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.5.3

```bash title="bun"
bun add bunqueue@2.5.3
```

```bash title="npm"
npm install bunqueue@2.5.3
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## 3 MCP Prompts

For AI agents, pre-built diagnostic templates:
- `bunqueue_health_report`, comprehensive server health report with severity levels
- `bunqueue_debug_queue`, deep diagnostic of a specific queue
- `bunqueue_incident_response`, step-by-step triage playbook for "jobs not processing"

## Bugfixes

- **MCP graceful shutdown**: `server.close()` now awaited before exit
- **MCP `getStorageStatus()` TCP**: verifies server reachability instead of returning hardcoded response
- **MCP `getChildrenValues()` TCP**: parallel fetch with `Promise.all` instead of sequential N+1
- **MCP resource error format**: includes `isError: true` consistent with tool errors
- **MCP pool size**: configurable via `BUNQUEUE_POOL_SIZE` env var (default: 2)

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.5.2](/blog/bunqueue-v2-5-2/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.5.3) · [Commits since v2.5.2](https://github.com/egeominotti/bunqueue/compare/v2.5.2...v2.5.3) · [Full changelog](/changelog/) · [All posts](/blog/)
