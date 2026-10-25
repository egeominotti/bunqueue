---
title: "bunqueue v2.6.16"
description: "Fixes 3 bugs. PUSH maxAttempts silently ignored via HTTP: The HTTP endpoint mapped attempts instead of maxAttempts, causing retry configuration to be discarded."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-16.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-14"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.16</em></h1>
  <p class="bq-hero-sub">Fixes 3 bugs. PUSH maxAttempts silently ignored via HTTP: The HTTP endpoint mapped attempts instead of maxAttempts, causing retry configuration to be discarded.</p>
</div>

#### To install bunqueue v2.6.16

```bash title="bun"
bun add bunqueue@2.6.16
```

```bash title="npm"
npm install bunqueue@2.6.16
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **PUSH `maxAttempts` silently ignored via HTTP**: The HTTP endpoint mapped `attempts` instead of `maxAttempts`, causing retry configuration to be discarded. Now correctly maps to `maxAttempts` (also accepts `attempts` for backwards compatibility).
- **GetJobs pagination broken via HTTP**: The HTTP endpoint sent `start`/`end` instead of `offset`/`limit`, causing query parameters to be silently ignored. Pagination now works correctly.
- **Batch HTTP endpoints unreachable**: `/jobs/ack-batch`, `/jobs/extend-locks`, and `/jobs/heartbeat-batch` were intercepted by the generic `/jobs/:id` pattern. Fixed by matching exact batch paths before the wildcard pattern.

---

[← bunqueue v2.6.15](/blog/bunqueue-v2-6-15/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.16) · [Commits since v2.6.15](https://github.com/egeominotti/bunqueue/compare/v2.6.15...v2.6.16) · [Full changelog](/changelog/) · [All posts](/blog/)
