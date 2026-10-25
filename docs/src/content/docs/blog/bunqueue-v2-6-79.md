---
title: "bunqueue v2.6.79"
description: "Fixes 1 bug. Issue #63 follow-up: getStallConfig() and getDlqConfig() in TCP mode now return the correct config after calling setStallConfig()/setDlqConfig() instead of always returning hardcoded defaults."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-79.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-25"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.79</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Issue #63 follow-up: getStallConfig() and getDlqConfig() in TCP mode now return the correct config after calling setStallConfig()/setDlqConfig() instead of always returning hardcoded defaults.</p>
</div>

#### To install bunqueue v2.6.79

```bash title="bun"
bun add bunqueue@2.6.79
```

```bash title="npm"
npm install bunqueue@2.6.79
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Issue #63 follow-up**: `getStallConfig()` and `getDlqConfig()` in TCP mode now return the correct config after calling `setStallConfig()`/`setDlqConfig()` instead of always returning hardcoded defaults. Added client-side cache so sync getters reflect the last-set values immediately

---

[← bunqueue v2.6.78](/blog/bunqueue-v2-6-78/) · [Full changelog](/changelog/) · [All posts](/blog/)
