---
title: "bunqueue v2.6.31"
description: "SandboxedWorker autoStart option."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-31.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-16"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.31</em></h1>
  <p class="bq-hero-sub">SandboxedWorker autoStart option.</p>
</div>

#### To install bunqueue v2.6.31

```bash title="bun"
bun add bunqueue@2.6.31
```

```bash title="npm"
npm install bunqueue@2.6.31
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## SandboxedWorker `autoStart` option

Automatically restart the worker pool when new jobs arrive after idle shutdown. Set `autoStart: true` with `idleTimeout` to get workers that sleep when idle and wake up when needed. Configurable poll interval via `autoStartPollMs` (default: 5000ms). Closes #51.

---

[← bunqueue v2.6.30](/blog/bunqueue-v2-6-30/) · [Full changelog](/changelog/) · [All posts](/blog/)
