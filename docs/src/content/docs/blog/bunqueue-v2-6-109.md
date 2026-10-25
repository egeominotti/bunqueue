---
title: "bunqueue v2.6.109"
description: "Cloud instance ID required: BUNQUEUE_CLOUD_INSTANCE_ID env var is now required for cloud mode (no more auto-generated UUIDs)."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-109.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-04-03"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.109</em></h1>
  <p class="bq-hero-sub">Cloud instance ID required: BUNQUEUE_CLOUD_INSTANCE_ID env var is now required for cloud mode (no more auto-generated UUIDs).</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.109

```bash title="bun"
bun add bunqueue@2.6.109
```

```bash title="npm"
npm install bunqueue@2.6.109
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Changes

- **Cloud instance ID required**: `BUNQUEUE_CLOUD_INSTANCE_ID` env var is now required for cloud mode (no more auto-generated UUIDs). If missing, cloud agent logs error and doesn't start; rest of bunqueue runs normally.
- **Simplified cloud config**: Config file `cloud` section only exposes `url`, `apiKey`, and `instanceId`. All other cloud settings are internal (env vars only).
- **Default changes**: `remoteCommands` defaults to `true` (was `false`), `includeJobData` defaults to `true` (was `false`).
- **Removed `instanceId.ts`**: Deleted auto-generation/persistence of instance IDs.
- **Updated docs**: Cloud section moved to end of configuration guide with beta notice.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.108](/blog/bunqueue-v2-6-108/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.109) · [Commits since v2.6.108](https://github.com/egeominotti/bunqueue/compare/v2.6.108...v2.6.109) · [Full changelog](/changelog/) · [All posts](/blog/)
