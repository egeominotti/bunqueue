---
title: "bunqueue v2.6.67"
description: "Disabled flaky SandboxedWorker tests: Commented out all 35 SandboxedWorker tests across 5 files."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-67.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.67</em></h1>
  <p class="bq-hero-sub">Disabled flaky SandboxedWorker tests: Commented out all 35 SandboxedWorker tests across 5 files.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.67

```bash title="bun"
bun add bunqueue@2.6.67
```

```bash title="npm"
npm install bunqueue@2.6.67
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Changes

- **Disabled flaky SandboxedWorker tests**: Commented out all 35 SandboxedWorker tests across 5 files. Bun's Worker threads are still unstable and cause intermittent race conditions and crashes in parallel test runs. Tests will be re-enabled once Bun Workers stabilize.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.66](/blog/bunqueue-v2-6-66/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.67) · [Commits since v2.6.65](https://github.com/egeominotti/bunqueue/compare/v2.6.65...v2.6.67) · [Full changelog](/changelog/) · [All posts](/blog/)
