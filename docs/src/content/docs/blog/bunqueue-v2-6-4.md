---
title: "bunqueue v2.6.4"
description: "Fixes 1 bug. SandboxedWorker generics, processor API improvements."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-4.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-05"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.4</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. SandboxedWorker generics, processor API improvements.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.4

```bash title="bun"
bun add bunqueue@2.6.4
```

```bash title="npm"
npm install bunqueue@2.6.4
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## SandboxedWorker generics

`SandboxedWorker<T>` now supports a generic type parameter for typed events (e.g., `worker.on('completed', (job: Job<MyData>) => ...)`)

## Processor API improvements

Processor files now receive `log()`, `fail()`, and `parentId` on the job object alongside `progress()`

## More additions

- Typed `on()`/`once()` overloads for all SandboxedWorker events (#25)

## Bugfixes

- **Lock token race condition**: Resolved race where concurrent ack/fail operations could use an expired lock token, causing "Invalid or expired lock token" errors under high concurrency. ([#28](https://github.com/egeominotti/bunqueue/issues/28))

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.2](/blog/bunqueue-v2-6-2/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.4) · [Commits since v2.6.2](https://github.com/egeominotti/bunqueue/compare/v2.6.2...v2.6.4) · [Full changelog](/changelog/) · [All posts](/blog/)
