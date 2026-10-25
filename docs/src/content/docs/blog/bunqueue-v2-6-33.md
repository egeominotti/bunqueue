---
title: "bunqueue v2.6.33"
description: "Fixes 1 bug. Worker log event: worker.on('log', (job, message) => ...) now works with full TypeScript autocomplete."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-33.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.33</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Worker log event: worker.on('log', (job, message) =&gt; ...) now works with full TypeScript autocomplete.</p>
</div>

#### To install bunqueue v2.6.33

```bash title="bun"
bun add bunqueue@2.6.33
```

```bash title="npm"
npm install bunqueue@2.6.33
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Worker `log` event**: `worker.on('log', (job, message) => ...)` now works with full TypeScript autocomplete. The `log` event is emitted when `job.log()` is called inside the processor, matching SandboxedWorker behavior. ([#53](https://github.com/egeominotti/bunqueue/issues/53))

---

[← bunqueue v2.6.32](/blog/bunqueue-v2-6-32/) · [Full changelog](/changelog/) · [All posts](/blog/)
