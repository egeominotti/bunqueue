---
title: "bunqueue v2.8.4"
description: "Fixes 5 bugs. Failed jobs were not enumerable on the storage path."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-4.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-06-05"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.4</em></h1>
  <p class="bq-hero-sub">Fixes 5 bugs. Failed jobs were not enumerable on the storage path.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.4

```bash title="bun"
bun add bunqueue@2.8.4
```

```bash title="npm"
npm install bunqueue@2.8.4
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

Two ways the counts and the per-state lists could disagree:

- **Failed jobs were not enumerable on the storage path.** A job that exhausts its
  attempts is moved to the `dlq` table and its `jobs` row is removed, so
  `getJobs({ state: 'failed' })` / `getFailedAsync()` ran `SELECT … FROM jobs WHERE
state='failed'` and came back empty, even though `failed` counted it, `getJobState()`
  returned `'failed'`, and `getJob(id)` found it (standalone server, and embedded with a
  `dataPath`). The storage path now also reads the DLQ for `'failed'`, mirroring the
  in-memory path. The unfiltered `getJobs()` likewise includes failed jobs.

- **`pause()` double-counted.** A single ready job was reported under **both** `waiting`
  and `paused`, while `getJobs({ state: 'paused' })` returned `[]`. Now follows BullMQ
  semantics: a paused queue reports its ready jobs (waiting **and** prioritized) under
  `paused`, with `waiting: 0` / `prioritized: 0`, and lists them via
  `getJobs({ state: 'paused' })`. A job is never counted in two buckets at once. Applied
  consistently across the client SDK, the TCP `GetJobCounts` handler, and the dashboard
  detail endpoint (which also gains a `paused` job list).

Also fixed a pagination defect surfaced by the DLQ merge: offset-unaware sources (DLQ,
paused/waiting-children views) are now gathered from index 0, merged, and sliced once, so
paged queries no longer duplicate or drop rows.

**Behavior change:** `getJobCounts()` on a paused queue previously returned the waiting
count under _both_ `waiting` and `paused`; it now returns `waiting: 0, paused: N`. The
monitoring aggregate `getStats()` (and `/stats` / Prometheus) keeps reporting physical
counts and is unaffected.

## Bugfixes

`package.json` declared `engines.node >= 18`, but the client cannot run on Node: the
published ESM uses directory/extensionless specifiers (Node's resolver rejects them with
`ERR_UNSUPPORTED_DIR_IMPORT`) and the TCP transport relies on Bun globals (`Bun.connect`,
`Bun.file`, `Bun.hash`, …) with no Node fallback.

- Dropped `node` from `engines` (now `bun >= 1.3.9` only).
- Added a `"bun"` export condition (the real entry) and a `"node"` condition pointing at a
  single self-contained stub on every subpath (`.`, `./client`, `./queue`, `./mcp`,
  `./workflow`). Importing from Node now fails fast with a clear _"bunqueue is Bun-only…"_
  error instead of a cryptic resolver crash; Bun resolves the real entry unchanged.
- Added a runtime guard for the bundled path (browser/neutral-target bundle run on Node).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.3](/blog/bunqueue-v2-8-3/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.4) · [Commits since v2.8.3](https://github.com/egeominotti/bunqueue/compare/v2.8.3...v2.8.4) · [Full changelog](/changelog/) · [All posts](/blog/)
