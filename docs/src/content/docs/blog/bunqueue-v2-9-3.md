---
title: "bunqueue v2.9.3"
description: "Fixes 33 bugs and ships 4 performance improvements and 5 additions. SQLite safety and queue-control release."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-9-3.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-09-02"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.9.3</em></h1>
  <p class="bq-hero-sub">Fixes 33 bugs and ships 4 performance improvements and 5 additions. SQLite safety and queue-control release.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

> **SQLite safety and queue-control release.** Completed history remains
> reachable after hot-cache eviction, cleanup and statistics use durable
> authority, and long schema upgrades are observable, bounded, and resumable.
> This release also completes BullMQ Pro-compatible job groups and native batch
> processing across embedded, TCP, and PostgreSQL runtimes.

#### To install bunqueue v2.9.3

```bash title="bun"
bun add bunqueue@2.9.3
```

```bash title="npm"
npm install bunqueue@2.9.3
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Upgrade notes

- Back up SQLite before upgrading. Schema 37 is applied before TCP/HTTP bind;
  legacy payload rewrites are restart-safe and resume from their last committed
  checkpoint, but a database with committed 2.9.3 migration batches must not be
  opened by an older binary. Roll forward, or restore the pre-upgrade database
  and binary together.
- `maxCompletedJobs` remains the hot-memory/recovery cap; it is not a disk
  retention policy. Configure `completedRetentionMs` when automatic expiry is
  desired. Deleted pages are reused by SQLite, but shrinking an already large
  file still requires an offline `VACUUM` with sufficient temporary space.
- PostgreSQL group support advances its schema to version 20. Upgrade all
  brokers in a cluster together; older brokers reject the newer schema instead
  of serving with mixed scheduling semantics.

## What's new

- Added opt-in durable completed-job retention through
  `storage.completedRetentionMs`, `BUNQUEUE_COMPLETED_RETENTION_MS`, and the
  `--completed-retention-ms` server flag. The cleanup tick removes bounded,
  oldest-first SQLite batches while protecting results owned by live
  dependency consumers.
- Added observable, resumable SQLite startup migrations with per-version
  markers, durable row/byte checkpoints for legacy payload rewrites, bounded
  500-row/8 MiB transactions, progress and duration logs, and a fail-fast guard
  for databases created by newer binaries. TCP and HTTP listeners now bind only
  after migration and recovery complete, so no partially initialized service is
  advertised during a long upgrade. Migration info records go to stderr while
  stdout remains machine-readable; recovery phase diagnostics use debug level.
  Any failure after storage opens also closes partial runtime timers, services,
  and SQLite before rethrowing, so invalid configuration or corrupt data exits
  promptly instead of wedging before listener bind.
- Added the BullMQ Pro compatibility layer without telemetry or NestJS:
  persistent group pause/resume, atomic group `maxSize`, intra-group priority,
  group job/priority queries, manual group rate limits, native batch processors
  with affinity/min-size/timeout and selective member failure, AbortSignal job
  cancellation/timeouts, structural Observable results, and the `QueuePro`,
  `WorkerPro`, `QueueEventsPro`, and `JobPro` aliases.
- Added first-class job groups to the Bun Queue and Worker APIs. Jobs accept
  `group: { id }`; ready ungrouped work has precedence, grouped work rotates
  fairly across IDs, and each group uses ascending priority with FIFO ties. New Queue getters
  expose queued depth per group, total grouped depth, and active depth. Workers
  can supply broker-authoritative per-group concurrency and fixed-window rate
  defaults, while Queue methods set/get/remove local overrides and inspect rate
  TTL. Overrides intentionally require the corresponding Worker default, and
  FIFO claim order does not imply serial execution: group concurrency remains
  unlimited unless configured. Real TCP/Worker E2E coverage verifies ordering,
  overrides, input validation, SQLite restart recovery, and obliterate cleanup.
- Quick Start: a "run it" step after the first snippet, with the run command for
  each of the seven runtimes and the expected output, plus explicit Rust and
  Elixir guidance for per-job outcomes where those SDKs have no event emitter.

## Performance

- In-batch deduplication replacements now lazily index pending persistence rows
  and tombstone superseded generations instead of repeatedly scanning and
  splicing the accepted array. On native macOS arm64 with Bun 1.4.0, the median
  reverse-order replacement batch of 20,000 inputs improved from 364.858ms to
  60.202ms (6.06x throughput), while the ordinary 20,000-input batch remained
  neutral at 38.428ms versus 37.594ms.
- Memory/SQLite group scheduling no longer scans and parks an ineligible prefix
  of the authoritative priority heap. Synchronous insert/remove hooks maintain
  lazy ungrouped/delayed heaps, a FIFO lane per group, O(1) circular rotation,
  and O(1) depth counters under the existing shard lock. Plain queues allocate
  no group scheduler state; blocked groups create no primary-heap reinsert churn.
- A native macOS arm64 A-B-B-A campaign against `c39facb9` placed 5,000 queued
  jobs from a saturated group ahead of another ready group. Across 14 samples
  per revision, scheduler median improved from 1.427042ms to 0.019542ms (73.02x)
  and p95 from 2.762375ms to 0.083417ms (33.12x), with the eligible job in every
  measured pull. These are dated host engineering measurements, not container
  or end-to-end application latency claims.
- The companion ordinary/mixed campaign records the cost as well as the win.
  Ungrouped median push/pull changed -3.12%/+0.88%; a 20,000-job half-grouped
  batch changed +43.18% for admission and +5.64% for claim. The candidate passed
  the strengthened mixed-order oracle in 14/14 samples while the old revision
  passed 0/14, so mixed timings are directional rather than same-contract. Raw
  reports mark the incorrect baseline samples non-comparable and are archived
  with the dated methodology. The optimization targets blocked-tenant scans,
  not every group workload.

## Changes

- SQLite schema version 37 adds exact per-queue retained-completion counters,
  queue-scoped/global deterministic retention indexes, a binary-ID tie-break
  for completed hot-cache recovery, and durable migration-progress bookkeeping.
  Completed totals now reflect SQLite authority rather than the bounded hot
  cache, and recovery probes only dependency IDs requested by each pending
  page.
- Updated the root README, internal architecture/feature references, protocol
  contract, public API types, Queue/Worker/Flow guides, migration/comparison
  matrices, and regenerated TypeDoc reference for the complete BullMQ Pro
  compatibility surface. Telemetry and NestJS remain explicitly excluded.
- SQLite schema version 36 persists group pause state. PostgreSQL schema
  version 20 adds group pause and manual rate-limit deadlines and extends the
  grouped ready index with priority ordering.
- SQLite schema version 35 adds durable `group_state` configuration. PostgreSQL
  schema version 19 adds a `BIGINT CACHE 1` grouped-admission sequence,
  `group_order`, exact FIFO/rotation indexes, and durable group state for
  configuration, effective fixed windows, active-capacity calculation, and
  `last_served`. Group claims, budgets, leases, and cursor movement commit in
  one transaction, so independent brokers share one exact order and capacity.
  Startup fingerprints every group column, primary-key semantic, index and
  sequence setting; bounded retention preserves live windows/overrides while
  reclaiming inactive rotation state.
  A v18 broker refuses to start against the upgraded schema; upgrade every
  broker in the cluster together.
- Group limit, duration, and concurrency controls now share positive-safe-
  integer validation before any state change. PostgreSQL uses `BIGINT` for the
  corresponding limits, counters, and concurrency state, preserving parity
  with embedded mode instead of rounding fractions at the database boundary.
- Intra-group priority now validates the BullMQ Pro integer range from `0` to
  `2,097,151` at the shared admission boundary for SQLite, TCP, flows, batches,
  and PostgreSQL.

## Bugfixes

- Fixed accepted SQLite-buffer jobs exposing or persisting their original
  waiting state after they had become active, waiting-children, delayed,
  retried, promoted, or completed. Pending lifecycle state is now explicit,
  survives a full timeline, and is used by point/list queries and eventual
  upserts. Automatic threshold/lifecycle flushes respect an outstanding
  exponential backoff, while batch transitions make at most one materialization
  attempt instead of exhausting all retries in one call. Evicted buffered
  completions remain queryable and keep their queue registered; reusing their
  custom ID retires the pending generation and stale result before admitting
  its successor. Stable mixed pagination now uses SQLite-compatible Unicode
  ordering, and non-round-trippable isolated-surrogate job IDs reject before
  admission.
- Fixed explicit `undefined` exceptions being mistaken for “no error” by batch
  admission and deferred buffer scopes. Error capture now tracks presence
  separately from the thrown value, preserving JavaScript throw semantics.
- Fixed completed SQLite rows becoming unreachable after eviction from
  `maxCompletedJobs`: `clean(..., 'completed')` now pages across cold database
  history and atomically removes jobs, results, and flow-failure records. This
  prevents unbounded disk growth when a retention policy is used and restores
  exact global/per-queue completed statistics. Trigger side effects are also
  accounted for when retrying completed jobs, preserving the atomic
  completed-to-waiting transition in embedded and TCP modes. Equal-timestamp
  in-memory cleanup now uses SQLite-compatible binary ID ordering instead of
  locale-sensitive sorting. Specific and bulk completed retry also reach cold
  SQLite rows; bulk selection uses bounded 500-row oldest-first keyset pages.
  Cleanup carries persisted queue ownership into cache convergence, preventing
  an old completion from deleting a newer same-ID generation in another queue.
- Fixed queue obliteration leaving cold results, logs, buffered jobs, or orphan
  child/parent-owned flow-failure rows behind. One storage-first transaction now
  clears jobs/results, DLQ, flow outbox, completion proofs/pins, telemetry, and
  queue/group state without materializing every historical job ID. Paired
  result/log owner indexes stay bounded with their LRUs, and a write failure at
  any deletion step leaves runtime state intact for an idempotent retry. ACK,
  ACKB, and FAIL revalidate processing ownership before terminal publication,
  so obliteration cannot race a late completion into resurrection. Buffered
  jobs now enter storage ownership before RAM publication, waiting-children
  callbacks run after complete single/batch/flow publication, and an admission
  tombstone removes the queue name immediately when a reentrant obliterate wins.
  Buffered batches coalesce threshold flushing at the outer admission boundary,
  and SQLite-backed queries merge still-buffered rows before stable pagination;
  exhaustive embedded reads therefore cannot truncate the unflushed tail.
  Same-ID guards cover both job and DLQ owners in another queue, including
  job-derived result and flow-failure deletion. Completed cleanup likewise
  preserves shared auxiliary rows whenever a same-ID DLQ generation survives.
- Fixed completed-only queue registration across cleanup and restart. Queue
  names now reconcile against exact SQLite counts in bounded batches, retain
  `waiting-children`, processing-transition, and queue/group-policy ownership,
  and disappear only after their last durable completion is removed. The
  `queue:removed` events are deferred until the reconciliation is complete, so
  synchronous recreation of the same or another queue cannot lose the new
  registration. Pending single, batch, and multi-queue flow admissions are now
  reference-counted across callbacks and lock waits; expired temporary rate
  limits and default-equivalent DLQ/stall settings no longer keep empty queues
  registered forever. Policy mutators register the queue before a durable write
  can throw, and empty/recovered queues delete stale queue/group state rows
  before unregistering their runtime name. Completed-only and policy-only names
  remain discoverable while their empty heap and secondary group runtime are
  reclaimed.
- Fixed memory-only `removeOnComplete` evidence retaining no source owner:
  obliterate now removes only the selected queue's bounded proofs, including
  after eviction and same-ID reuse. Memory-only cleanup also preserves a live
  completed-only queue. Reusing a completed custom ID that is cold in SQLite
  now retires its stale result atomically before publishing the successor.
  Every terminal custom-ID reuse also clears generation-scoped results, logs,
  and their bounded queue-owner indexes before the successor becomes visible,
  including completed and DLQ reuse across queues.
- Invalid programmatic `completedRetentionMs` values can no longer trigger
  destructive expiry: direct and server configuration now share the same
  finite, non-negative, safe-integer normalization.
- Native batches now reserve one Worker limiter slot per member only when the
  batch is ready, so `minSize` accumulation consumes no capacity and concurrent
  batches cannot exceed the configured start budget. A synchronously throwing
  batch processor is invoked once, and synchronous Observable completion/error
  now runs the returned teardown exactly once. Cancelling or timing out any
  batch member aborts the shared processor signal; impossible global-limiter
  configurations with `minSize > limiter.max` now reject at construction while
  larger `size` values continue in bounded chunks.
- PostgreSQL group `maxSize` admission now serializes the count-and-insert
  decision across brokers with sorted transaction-scoped capacity locks. Manual
  group rate-limit TTL queries now report the live manual deadline, and
  intra-group priority follows BullMQ Pro ordering (`0` first, then ascending).
- A `Job` returned from TCP `Queue.add()` now reflects `group.priority` exactly
  like embedded mode and TCP bulk admission.
- Atomic `FlowProducer` planning now preserves group IDs, intra-group priority,
  and `maxSize`; invalid group options reject the complete graph before writes.
- CI: the deterministic SQLite telemetry batching campaign now has an explicit
  15-second timeout, preserving all coverage while avoiding false failures when
  shared runners temporarily exceed Bun's 5-second default.
- Documentation site: hero blocks whose content spanned several source lines
  made MDX emit a markdown paragraph inside them, producing invalid `<p>` in
  `<h1>` and `<p>` in `<p>` on 33 pages. The nested paragraph also inherited the
  1.75 body line-height, so hero headings rendered with a ~1.75 leading instead
  of the intended 1.05 and broke across lines. All hero headings and ledes are
  now single-line, and a CSS guard keeps hero typography correct if it regresses.
- Documentation site: `.bq-wrap` sits inside `.content-panel`, which already
  supplies the page gutter, but added another 3rem, so every hero was inset 48px
  from the prose below it. Above the 38rem phone layer every `.bq-wrap` on a
  non-splash hero page now drops that inset, which also keeps pages that continue
  in `.bq-wrap` sections (the production guide, the blog index) on one left edge
  from hero to last section. The home splash keeps its inset.
- Quick Start: the "React to events" and Simple Mode tab groups were missing
  languages while sharing `syncKey="lang"`. Starlight syncs tab sets by label,
  so a reader on Rust, Elixir, PHP or Go silently fell back to the Bun tab and
  was shown TypeScript. Every synced group on the page now carries the same
  seven labels.
- Quick Start: the MCP setup used `bun add bunqueue` plus `bunx bunqueue-mcp`,
  but the `bunqueue-mcp` binary ships inside `bunqueue` and is not a package of
  its own. It now matches the MCP guide: `bun add -g` plus
  `bunx --package=bunqueue bunqueue-mcp`.
- Quick Start: the Python first snippet called `Worker(...).run()` inline, so
  the `worker` handle used by the later events section did not exist. It now
  binds `worker` before running it.
- Documentation site: the nested-paragraph defect also affected `.bq-lede`,
  `.bq-chart-title`, `.bq-vs-sum`, `.bq-bench-title`, `.bq-bench-foot` and
  `.bq-pipeline-caption` blocks on the home page, the comparison page, the
  production page and two blog posts. Every literal `<p>`/`<hN>` JSX block in the
  content sources now keeps its text on one line, and the built site has no
  nested paragraph left.
- Documentation site: `bunx bunqueue-mcp` appeared in the home page, the server
  guide, the cron reference and the env-vars guide. `bunqueue-mcp` is a binary
  inside `bunqueue`, not a package, so the bare form 404s (the MCP guide already
  documented that). Every call site, including `README.md`, now uses
  `bunx --package=bunqueue bunqueue-mcp`.
- Documentation site: deployment, server, env-vars, troubleshooting and the
  production blog post configured persistence through `DATA_PATH` while the
  env-vars reference documents `BUNQUEUE_DATA_PATH` as canonical. Examples now use
  the canonical name; the fallbacks are unchanged and still documented.
- Documentation site: many tab groups were missing languages while sharing
  `syncKey="lang"`. Starlight syncs tab groups by label through localStorage, so a
  group without the reader's label silently fell back to its first tab and showed
  the wrong language, both between adjacent groups on one page and across pages.
  All 128 `lang` groups site-wide now carry the same seven labels in the same
  order, filling gaps with an explicit pointer instead of a silent fallback:
  Quick Start, webhooks, flow patterns and failures, use cases, examples,
  troubleshooting, Simple Mode and the BullMQ migration guide.
- Documentation site: the flow-patterns guide said per-queue defaults
  (`queuesOptions`) were supported in the Bun package and the Python SDK only. The
  TypeScript SDK implements them too (`sdk/typescript/src/flow-types.ts`,
  `flow-plan.ts`), so the Node.js / Deno tab now carries the real
  `bunqueue-client` snippet and every mention names all three.
- Documentation site: `guide/queue-group` was a `.md` file that used `<Tabs>` and
  `<TabItem>`. Plain Markdown does not process components, so the page printed the
  literal `import { Tabs, TabItem } ...` line as body text and rendered its four tab
  groups as a flat stack of code blocks. Renamed to `.mdx`; the page now renders its
  tabs and joins the site-wide `lang` sync (128 groups, one label set). The doc-audit
  fixtures in `test/docs-language-tabs.test.ts`,
  `test/docs-queue-snippets.test.ts` and `test/documented-feature-coverage.test.ts`
  follow the new extension: the glob had been silently matching nothing, so the
  page's four language groups were not label-audited at all.
- Documentation site: the SDK guide labels the TypeScript SDK as a single tab, a
  different vocabulary from the runtime-oriented groups elsewhere, so a reader who
  had picked Bun or Node.js / Deno matched nothing and fell back silently. Its
  groups now use their own `syncKey="sdk"`.
- Documentation site: Elixir guidance referred to a "telemetry callback"; the
  Elixir SDK spells that option `:event_handler` on the connection.
- Documentation site: the SDK guide offered ACK batching placeholders that pointed
  PHP, Go, Rust and Elixir readers at a non-existent equivalent. Batching is a
  TypeScript and Python feature; the other workers acknowledge each job
  individually, and the tabs now say so.
- Quick Start: the persistence section advertised `DATA_PATH`; `BUNQUEUE_DATA_PATH`
  is the canonical variable and `BQ_DATA_PATH`, `DATA_PATH`, `SQLITE_PATH` are
  ordered fallbacks. The section now shows the server-mode `--data-path` step and
  states that a _different_ embedded `dataPath` throws instead of opening a second
  database. The "Setup" table row also uses `bunx bunqueue start`, like the rest
  of the page.
- The embedded heartbeat-token regression now advances a controlled wall clock
  and checks each lease's renewal count and expiry directly. Single,
  acknowledgement, and batch coverage still cross the original expiry without
  depending on a 50-millisecond real-time scheduling window.
- Real-executable CLI campaigns now use a 20-second aggregate test deadline
  while retaining the 5-second watchdog around every child process. Contended
  runners no longer kill a healthy final command in the sequential matrix, and
  individual CLI hangs remain bounded and attributable.
- The sustained-churn soak test now records worker-termination-attempt cadence
  with a monotonic clock and validates both density and full-window coverage. It still
  rejects sparse, clustered, or long-gap churn, but a contended CI runner no
  longer fails solely because timer callbacks cannot match their ideal cadence.
- Embedded Queue group operations and grouped `add`/`addBulk` now reopen the
  Queue's explicit SQLite `dataPath` after the shared manager is restarted,
  rather than silently recreating an unrelated default in-memory manager.
- Group FIFO order now uses a hidden monotonic admission ordinal. It remains
  stable across reverse-sorting custom IDs, equal timestamps, priority/delay
  changes, SQLite restart, PostgreSQL broker restart, and batch chunk boundaries.
- Embedded group controls now validate direct QueueManager calls and commit
  SQLite before changing runtime policy or waking waiters. Policy-column reset
  and conditional empty-row deletion share one transaction, so a failure in
  either statement leaves durable and runtime policy unchanged. Cleanup
  preserves exact active set/count ownership above 1,000 concurrent groups,
  and `bunqueue/client` exports the documented group option types.

## Documentation

- Audited the 12 server/operations guide pages and re-audited the Worker pages
  against the source, correcting: `/health` returning HTTP 503 with the
  `storage` object only when degraded; the config-file `timeouts.worker`,
  `timeouts.lock`, and `webhooks` keys documented as currently ignored (env
  vars `WORKER_TIMEOUT_MS`, `LOCK_TIMEOUT_MS`, `WEBHOOK_MAX_RETRIES`,
  `WEBHOOK_RETRY_DELAY_MS` are the working knobs); the JSON log example
  rewritten to the real `{timestamp, level, component, message, data?}` shape;
  the `/stats` field list (no `failed` key; `memory`/`collections` are
  top-level); `skipLockRenewal` suppressing the whole per-job heartbeat (stall
  freshness included, even with `useLocks: false`); SandboxedWorker
  `pollInterval` paced only when no idle thread exists (pulls use a fixed 1s
  long-poll); stall detection floor corrected to ~35–40s; the PHP worker
  leasing its full `batchSize` up front and processing sequentially;
  `cancelJob` returning `false` for pulled-but-not-started jobs; and the
  Worker overview stating `attempts` as total executions.

- Audited the 24 Queue and Worker guide pages against the source and corrected
  every claim that contradicted the implementation: `attempts` documented as
  total executions (not retries) and numeric `backoff` as the exponential base
  capped at 1h; `drain()` noted to also remove delayed jobs; `getJobCounts()`
  no longer listed as embedded-only; `getWaitingChildren` inclusive `end`;
  dedup `extend` rejection when the key owner is no longer pending, and the
  Node SDK's `getDeduplicationJobId()`; embedded `addBulk` accepted-prefix
  behavior under group `maxSize`; the nine previously missing `JobOptions`
  fields in the reference table; PostgreSQL `getRateLimitTtl` returning `0`;
  `RATE_LIMIT_*` env vars described as protocol-level request limiting; stall
  detection two-phase ~35s timing, backoff-delayed heartbeat-stall retry,
  `max_attempts_exceeded` precedence over `stalled`, `job:stalled` SSE event
  name, and external SDK `getDlq` returning raw jobs without `reason`;
  Worker `removeOnComplete`/`removeOnFail` non-boolean values ignored rather
  than treated as `false`; `attemptsMade` as attempts consumed so far; batch
  processor throw semantics vs `setAsFailed()`; SandboxedWorker
  `completed`/`failed` events emitted after broker confirmation,
  `maxRestarts` off-by-one budget, and removal of the unverifiable
  "experimental by bunqueue" wording; Elixir bulk `promote_jobs/1`; and the
  Bun-only `moveJobToWaitingChildren`.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.9.2](/blog/bunqueue-v2-9-2/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.9.3) · [Commits since v2.9.2](https://github.com/egeominotti/bunqueue/compare/v2.9.2...v2.9.3) · [Full changelog](/changelog/) · [All posts](/blog/)
