---
title: "bunqueue v2.6.94"
description: "Claude Code plugin & skills."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-94.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.94</em></h1>
  <p class="bq-hero-sub">Claude Code plugin &amp; skills.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.94

```bash title="bun"
bun add bunqueue@2.6.94
```

```bash title="npm"
npm install bunqueue@2.6.94
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Claude Code plugin & skills

AI-native integration for bunqueue (closes #71):
- `.claude-plugin/plugin.json`, distributable plugin manifest, installable via `/plugin marketplace add egeominotti/bunqueue`
- `skills/bunqueue/SKILL.md`, public skill with Simple Mode (all 12 features), Queue+Worker, auto-batching, QueueGroup, webhooks, S3 backup, MCP server, BullMQ migration guide
- `skills/bunqueue/reference.md`, full API reference (Queue, Worker, Bunqueue, FlowProducer, QueueGroup, all options)
- `skills/bunqueue/examples.md`, 10 real-world patterns (email service, API gateway, ETL pipeline, webhook processor, image processing, batch DB, multi-queue, cron reports, distributed TCP, search debounce, OTP with TTL) + BullMQ migration checklist
- `skills/bunqueue/mcp.md`, MCP server documentation (73 tools, 5 resources, 3 diagnostic prompts, setup for embedded & TCP)
- `.claude/skills/bunqueue-dev/SKILL.md`, internal contributor skill (architecture, conventions, testing workflow)

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.93](/blog/bunqueue-v2-6-93/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.94) · [Commits since v2.6.92](https://github.com/egeominotti/bunqueue/compare/v2.6.92...v2.6.94) · [Full changelog](/changelog/) · [All posts](/blog/)
