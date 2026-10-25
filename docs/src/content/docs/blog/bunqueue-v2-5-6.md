---
title: "bunqueue v2.5.6"
description: "Fixes 3 bugs. 3 new TCP commands."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-5-6.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-02-27"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.5.6</em></h1>
  <p class="bq-hero-sub">Fixes 3 bugs. 3 new TCP commands.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.5.6

```bash title="bun"
bun add bunqueue@2.5.6
```

```bash title="npm"
npm install bunqueue@2.5.6
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## 3 new TCP commands

For MCP protocol optimization (73 tools total):
- `CronGet`, fetch a single cron job by name instead of listing all and filtering client-side
- `GetChildrenValues`, batch-fetch children return values in a single command instead of N+1 queries
- `StorageStatus`, return real disk/storage health from the server instead of hardcoded `diskFull: false`

## More additions

- 9 new tests for the 3 TCP commands (`test/tcp-new-commands.test.ts`)

## Bugfixes

- **MCP TCP `getCron(name)`**: now uses dedicated `CronGet` command instead of fetching all crons and filtering client-side
- **MCP TCP `getChildrenValues(id)`**: now uses dedicated `GetChildrenValues` command instead of 1 + 2N queries (GetJob parent + GetResult/GetJob per child)
- **MCP TCP `getStorageStatus()`**: now uses dedicated `StorageStatus` command instead of returning hardcoded `{ diskFull: false }`

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.5.5](/blog/bunqueue-v2-5-5/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.5.6) · [Commits since v2.5.5](https://github.com/egeominotti/bunqueue/compare/v2.5.5...v2.5.6) · [Full changelog](/changelog/) · [All posts](/blog/)
