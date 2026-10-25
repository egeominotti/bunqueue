---
title: "bunqueue v2.6.2"
description: "Fixes 1 bug and ships 1 addition. job.name always 'default' for scheduled jobs: When jobs were created via Queue#upsertJobScheduler, the name from jobTemplate was not embedded in the cron job data."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-2.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-03"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.2</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug and ships 1 addition. job.name always 'default' for scheduled jobs: When jobs were created via Queue#upsertJobScheduler, the name from jobTemplate was not embedded in the cron job data.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.2

```bash title="bun"
bun add bunqueue@2.6.2
```

```bash title="npm"
npm install bunqueue@2.6.2
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

- Regression test for scheduler job name passthrough (`test/bug-23-scheduler-job-name.test.ts`)

## Bugfixes

- **`job.name` always `'default'` for scheduled jobs**: When jobs were created via `Queue#upsertJobScheduler`, the `name` from `jobTemplate` was not embedded in the cron job data. The worker fell back to `'default'`. Now embeds the name in data, matching `Queue.add()` behavior. (Discussion #23)

## Documentation

- Added SandboxedWorker Options Reference table
- Added SandboxedWorker Event Reference table with types
- Clarified which events are not available on SandboxedWorker (`stalled`, `drained`, `cancelled`)
- Added tip about increasing `maxMemory` for large file processing
- Fixed missing `await` on `worker.start()` calls
- Improved Worker vs SandboxedWorker comparison table

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.1](/blog/bunqueue-v2-6-1/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.2) · [Commits since v2.6.1](https://github.com/egeominotti/bunqueue/compare/v2.6.1...v2.6.2) · [Full changelog](/changelog/) · [All posts](/blog/)
