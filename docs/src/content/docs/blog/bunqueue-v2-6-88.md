---
title: "bunqueue v2.6.88"
description: "Fixes 1 bug. ESLint crash on flow.ts: removed unnecessary explicit <T> type arguments from createFlowJobObject calls that caused @typescript-eslint/no-unnecessary-type-arguments rule to crash during bun run lint."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-88.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-30"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.88</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. ESLint crash on flow.ts: removed unnecessary explicit &lt;T&gt; type arguments from createFlowJobObject calls that caused @typescript-eslint/no-unnecessary-type-arguments rule to crash during bun run lint.</p>
</div>

#### To install bunqueue v2.6.88

```bash title="bun"
bun add bunqueue@2.6.88
```

```bash title="npm"
npm install bunqueue@2.6.88
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **ESLint crash on `flow.ts`**: removed unnecessary explicit `<T>` type arguments from `createFlowJobObject` calls that caused `@typescript-eslint/no-unnecessary-type-arguments` rule to crash during `bun run lint`.

---

[← bunqueue v2.6.87](/blog/bunqueue-v2-6-87/) · [Full changelog](/changelog/) · [All posts](/blog/)
