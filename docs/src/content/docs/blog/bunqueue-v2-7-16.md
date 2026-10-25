---
title: "bunqueue v2.7.16"
description: "Fixes 1 bug. MCP returns inconsistent numbers across monitoring tools (#87): In TCP mode the MCP TcpBackend parsed several TCP response envelopes at the wrong nesting level, so monitoring tools returned wrong or empty data even though the…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-7-16.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-05-29"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.7.16</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. MCP returns inconsistent numbers across monitoring tools (#87): In TCP mode the MCP TcpBackend parsed several TCP response envelopes at the wrong nesting level, so monitoring tools returned wrong or empty data even though the…</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

## Bugfixes

- **MCP returns inconsistent numbers across monitoring tools (#87)**: In TCP mode the MCP `TcpBackend` parsed several TCP response envelopes at the wrong nesting level, so monitoring tools returned wrong or empty data even though the CLI (which parses correctly) worked. Fixed: `bunqueue_get_job_counts` now reads `res.counts.*` (was reading top-level → always `0`); `bunqueue_list_workers` reads `res.data.workers` with the correct field names (`processedJobs`/`failedJobs`/`lastSeen`) and no longer returns `[]` for a registered worker; `bunqueue_get_jobs` maps the tool's `start`/`end` to the protocol's `offset`/`limit` so pagination works (previously `start` was ignored and the page defaulted to 100 instead of the requested size); `bunqueue_get_per_queue_stats` now uses the `DashboardQueues` command for a real per-queue breakdown (`{waiting, prioritized, delayed, active, dlq}`) instead of global `Metrics`, matching embedded mode. The `DashboardQueues` handler now also forwards `prioritized`.

## Notes

- `bunqueue_get_counts_per_priority` counts only waiting/delayed (queued) jobs, active, completed and failed jobs are not included. The tool description now states this explicitly.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.7.15](/blog/bunqueue-v2-7-15/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.7.16) · [Commits since v2.7.15](https://github.com/egeominotti/bunqueue/compare/v2.7.15...v2.7.16) · [Full changelog](/changelog/) · [All posts](/blog/)
