---
title: "bunqueue v2.8.34"
description: "Fixes 2 bugs and ships 4 additions. bun run test:sandbox builds the current worktree into one pinned Debian/Bun test image and runs the mandatory unit, TCP, and embedded suites concurrently in three disposable containers."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-34.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-17"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.34</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs and ships 4 additions. bun run test:sandbox builds the current worktree into one pinned Debian/Bun test image and runs the mandatory unit, TCP, and embedded suites concurrently in three disposable containers.</p>
</div>

#### To install bunqueue v2.8.34

```bash title="bun"
bun add bunqueue@2.8.34
```

```bash title="npm"
npm install bunqueue@2.8.34
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

- `bun run test:sandbox` builds the current worktree into one pinned Debian/Bun
  test image and runs the mandatory unit, TCP, and embedded suites concurrently
  in three disposable containers. Containers have no host mounts or external
  network, run non-root with capabilities dropped, and use independent
  filesystems, ports, processes, and SQLite databases.
- Every run preserves complete suite logs, timestamped Docker resource samples
  in NDJSON, per-suite JSON, and an aggregate JSON/Markdown report. KPIs include
  duration and test/file counts, CPU average/p95/peak, memory start/p95/end/peak
  and slope, PID peak, block/network I/O, slow-test rankings, OOM detection, and
  baseline regression signals.
- TCP functional files now each start a fresh server with dynamic TCP/HTTP ports
  and a unique temporary SQLite database. This removes cross-file state and port
  coupling while keeping the exact public persistence path under test.
- `AGENTS.md`, `CLAUDE.md`, CI, and the internal architecture/testing reference
  now define the same mandatory three-suite gate, containment limits, diagnostic
  fallback, telemetry review, and native-only benchmark policy.

## Bugfixes

- Bulk promotion no longer queries the eventually consistent SQLite listing
  before the write-behind buffer has flushed. Embedded and TCP modes now select
  delayed jobs from the live shard in stable `(createdAt, id)` order, apply an
  exact optional count, update heap/temporal tracking/counters under one shard
  lock, wake queue-local waiters once, and persist every promoted `run_at` before
  resolving.
- The single-job promotion path now maintains the same delayed tracking,
  persistence, and waiter invariants. The regression keeps non-durable delayed
  seeds specifically to cover the former write-buffer race and verifies
  `count: 0`, live counts, and SQLite-backed listings.

Validation on Bun 1.3.14: 5,845 unit tests passed (3 explicitly skipped), 402
TCP assertions passed across 60 fresh-server files, and 273 embedded assertions
passed across 36 files. The parallel gate completed in 15.15 minutes with no
failures or OOM events; its full telemetry is retained as a local build artifact.

---

[← bunqueue v2.8.33](/blog/bunqueue-v2-8-33/) · [Full changelog](/changelog/) · [All posts](/blog/)
