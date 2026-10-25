---
title: "bunqueue v2.8.45"
description: "The startup banner and CLI help now use One queue."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-45.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-22"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.45</em></h1>
  <p class="bq-hero-sub">The startup banner and CLI help now use One queue.</p>
</div>

#### To install bunqueue v2.8.45

```bash title="bun"
bun add bunqueue@2.8.45
```

```bash title="npm"
npm install bunqueue@2.8.45
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Changes

- The startup banner and CLI help now use `One queue. Any language.` instead
  of describing bunqueue as a job queue limited to Bun. The server and embedded
  runtime remain Bun-native, while network clients can use other runtimes and
  languages.
- Startup state is easier to scan with aligned labels and distinct markers for
  enabled, disabled and informational rows. Storage now identifies ephemeral
  in-memory operation or the configured SQLite path, and Unix sockets and
  logical CPU counts use explicit terminology.
- The documentation terminal mirrors the production banner, and regression
  coverage starts a real broker to protect the product line and status layout.

---

[← bunqueue v2.8.44](/blog/bunqueue-v2-8-44/) · [Full changelog](/changelog/) · [All posts](/blog/)
