---
title: "bunqueue v2.5.4"
description: "4 MCP Flow Tools."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-5-4.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.5.4</em></h1>
  <p class="bq-hero-sub">4 MCP Flow Tools.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.5.4

```bash title="bun"
bun add bunqueue@2.5.4
```

```bash title="npm"
npm install bunqueue@2.5.4
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## 4 MCP Flow Tools

Job workflow orchestration via MCP (70 tools total):
- `bunqueue_add_flow`, create flow trees with parent/children dependencies (BullMQ v5 compatible)
- `bunqueue_add_flow_chain`, sequential pipelines: A → B → C
- `bunqueue_add_flow_bulk_then`, fan-out/fan-in: parallel jobs → final merge
- `bunqueue_get_flow`, retrieve flow trees with full dependency graph

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.5.3](/blog/bunqueue-v2-5-3/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.5.4) · [Commits since v2.5.3](https://github.com/egeominotti/bunqueue/compare/v2.5.3...v2.5.4) · [Full changelog](/changelog/) · [All posts](/blog/)
