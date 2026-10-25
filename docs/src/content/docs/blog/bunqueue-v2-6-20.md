---
title: "bunqueue v2.6.20"
description: "Fixes 3 bugs. Centralized HTTP JSON body parsing: Replaced per-file parseBody() with shared parseJsonBody() that returns proper 400 responses for invalid JSON instead of silently falling back to {}."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-20.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.20</em></h1>
  <p class="bq-hero-sub">Fixes 3 bugs. Centralized HTTP JSON body parsing: Replaced per-file parseBody() with shared parseJsonBody() that returns proper 400 responses for invalid JSON instead of silently falling back to {}.</p>
</div>

#### To install bunqueue v2.6.20

```bash title="bun"
bun add bunqueue@2.6.20
```

```bash title="npm"
npm install bunqueue@2.6.20
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Centralized HTTP JSON body parsing**: Replaced per-file `parseBody()` with shared `parseJsonBody()` that returns proper 400 responses for invalid JSON instead of silently falling back to `{}`.
- **Dashboard pagination**: Added `limit` and `offset` query parameters to `GET /dashboard/queues`. Workers and crons lists capped at 100 entries with `truncated` flag.
- **ESLint complexity reduction**: Extracted job push/pull/bulk operations into `routeJobOps()` helper to keep `routeQueueRoutes` under the 45-branch complexity limit.

---

[← bunqueue v2.6.19](/blog/bunqueue-v2-6-19/) · [Full changelog](/changelog/) · [All posts](/blog/)
