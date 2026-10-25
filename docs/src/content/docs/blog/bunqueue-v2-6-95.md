---
title: "bunqueue v2.6.95"
description: "AI-native completeness."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-95.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-31"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.95</em></h1>
  <p class="bq-hero-sub">AI-native completeness.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.95

```bash title="bun"
bun add bunqueue@2.6.95
```

```bash title="npm"
npm install bunqueue@2.6.95
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## AI-native completeness

Three additions for perfect Claude Code integration:
- `.mcp.json` at root, auto-discovery of bunqueue MCP server, no manual config needed
- `agents/bunqueue-assistant.md`, specialized agent that Claude auto-delegates to for bunqueue tasks (setup, debugging, migration, optimization)
- Updated `plugin.json` v1.1.0, declares all components (skills, agents, MCP), adds keywords for discoverability

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.94](/blog/bunqueue-v2-6-94/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.95) · [Commits since v2.6.94](https://github.com/egeominotti/bunqueue/compare/v2.6.94...v2.6.95) · [Full changelog](/changelog/) · [All posts](/blog/)
