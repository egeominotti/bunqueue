---
title: "bunqueue v2.4.2"
description: "CPU-Intensive Workers guide, CPU stress test script."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-4-2.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-02-13"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.4.2</em></h1>
  <p class="bq-hero-sub">CPU-Intensive Workers guide, CPU stress test script.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.4.2

```bash title="bun"
bun add bunqueue@2.4.2
```

```bash title="npm"
npm install bunqueue@2.4.2
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## CPU-Intensive Workers guide

New dedicated docs page for handling CPU-heavy jobs over TCP
- Explains the ping health check failure chain that causes job loss after ~90s of CPU load
- Connection tuning: `pingInterval: 0`, `commandTimeout: 60000`
- Non-blocking CPU patterns with `await Bun.sleep(0)` yield
- Default timeouts reference table
- SandboxedWorker as alternative for truly CPU-bound work

## CPU stress test script

`scripts/stress-cpu-intensive.ts` (500 jobs, 5 CPU task types, concurrency 3)

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.4.1](/blog/bunqueue-v2-4-1/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.4.2) · [Commits since v2.4.1](https://github.com/egeominotti/bunqueue/compare/v2.4.1...v2.4.2) · [Full changelog](/changelog/) · [All posts](/blog/)
