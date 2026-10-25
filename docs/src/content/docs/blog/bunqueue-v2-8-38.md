---
title: "bunqueue v2.8.38"
description: "bunqueue 2.8.38 release notes."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-38.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-18"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.38</em></h1>
  <p class="bq-hero-sub">bunqueue 2.8.38 release notes.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.38

```bash title="bun"
bun add bunqueue@2.8.38
```

```bash title="npm"
npm install bunqueue@2.8.38
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Changes

The package README was rewritten from a 958-line reference dump into a
~370-line adoption path: quickstart (embedded and server in the first
screen), why/when comparison, the two modes, the six-language SDK table,
Simple Mode and Workflow teasers, and a short MCP setup, each section
deep-linking to the corresponding bunqueue.dev guide. Duplicated
sections, stale SDK lists and internal test details were removed; every
surviving claim and code sample was re-verified against the current API.
The README and the site now state explicitly that the server and the
embedded queue run in-memory unless a data path is configured.

## Changes

Twenty guide pages now show each client example in synced language tabs
covering Bun, Node.js/Deno, Python, PHP, Go, Rust and Elixir: the queue,
worker, quickstart, cron, DLQ, rate-limiting, flows, Simple Mode, TLS,
stall-detection, webhooks, troubleshooting, FAQ, security, migration,
installation, introduction, databases, examples and use-cases pages.
Every non-TypeScript sample was verified against the SDK sources; where
a feature does not exist in a language the docs say so explicitly
instead of showing code that would not compile. Bun-only pages
(workflow engine, QueueGroup, IoT forward(), Elysia/Hono, sandboxed
workers) carry an explicit runtime callout.

## Changes

The home hero now shows the real `bunx bunqueue start` boot output in an
animated, replayable terminal next to the per-language install step, with
Rust and Elixir added everywhere (install chips, language cards, trust
line). The quickstart and developer-experience code examples switched to
language tabs covering Bun, Node.js/Deno, Python, PHP, Go, Rust and
Elixir, the benchmark card moved next to the BullMQ comparison, and the
layout uses the full desktop width.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.37](/blog/bunqueue-v2-8-37/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.38) · [Commits since v2.8.37](https://github.com/egeominotti/bunqueue/compare/v2.8.37...v2.8.38) · [Full changelog](/changelog/) · [All posts](/blog/)
