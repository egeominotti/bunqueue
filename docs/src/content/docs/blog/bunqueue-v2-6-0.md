---
title: "bunqueue v2.6.0"
description: "Fixes 5 bugs. 8 new TCP command handlers, updateJobData / updateJobChildrenIds."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-0.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.0</em></h1>
  <p class="bq-hero-sub">Fixes 5 bugs. 8 new TCP command handlers, updateJobData / updateJobChildrenIds.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.0

```bash title="bun"
bun add bunqueue@2.6.0
```

```bash title="npm"
npm install bunqueue@2.6.0
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## 8 new TCP command handlers

`ClearLogs`, `ExtendLock`, `ExtendLocks`, `ChangeDelay`, `SetWebhookEnabled`, `CompactMemory`, `MoveToWait`, `PromoteJobs`. These commands were already sent by the client SDK and MCP adapter but had no server-side handler, causing silent `Unknown command` errors in TCP mode. All 8 are now fully functional.

## `updateJobData` / `updateJobChildrenIds`

Persistence methods added to `SqliteStorage` for parent-child relationship durability.

## More additions

- 20 new regression tests covering all fixes in this release.

## Bugfixes

- **Expired lock requeue not updating stats**: When a job's lock expired and was requeued for retry, `requeueExpiredJob` in `lockManager.ts` did not call `shard.incrementQueued()` or `shard.notify()`. This caused `getStats()` to report 0 waiting jobs and workers in long-poll mode to not wake up for the requeued job.
- **`updateJobParent` not persisting to SQLite**: `childrenIds` and `__parentId` mutations were only applied in memory. After a server restart, all parent-child flow relationships were lost. Now properly persisted via dedicated SQLite update methods.
- **`getJob` returning null for completed jobs without storage**: In no-SQLite mode (embedded without persistence), `getJob()` returned `null` for completed/DLQ jobs because it only checked `ctx.storage?.getJob()`. Now falls back to `ctx.completedJobsData` in-memory map.
- **MCP `UnregisterWorker` field mismatch**: MCP adapter sent `{ cmd: 'UnregisterWorker', id }` but the server expected `{ workerId }`. Worker unregistration via MCP in TCP mode always failed silently. Fixed to send the correct field name.
- **`JobHeartbeat` ignoring `duration` field**: When the MCP adapter sent a `JobHeartbeat` with a custom `duration`, the handler ignored it and renewed the lock with the default TTL. Now properly extends the lock with the requested duration via `renewJobLock()`.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.5.8](/blog/bunqueue-v2-5-8/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.0) · [Commits since v2.5.8](https://github.com/egeominotti/bunqueue/compare/v2.5.8...v2.6.0) · [Full changelog](/changelog/) · [All posts](/blog/)
