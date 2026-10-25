---
title: "bunqueue v2.9.0"
description: "Fixes 43 bugs and ships 19 performance improvements. PostgreSQL without a compatibility driver, real multi-broker coordination, failure is part of the contract, one runtime dependency and more."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-9-0.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-08-28"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.9.0</em></h1>
  <p class="bq-hero-sub">Fixes 43 bugs and ships 19 performance improvements. PostgreSQL without a compatibility driver, real multi-broker coordination, failure is part of the contract, one runtime dependency and more.</p>
</div>

> **The multi-broker release.** Keep bunqueue's one-file SQLite deployment when
> that is the right boundary, or point standalone servers at PostgreSQL and run
> several active brokers against one authoritative queue. The public Queue,
> Worker, Flow, cron, retry, result, and DLQ contracts stay the same.

#### To install bunqueue v2.9.0

```bash title="bun"
bun add bunqueue@2.9.0
```

```bash title="npm"
npm install bunqueue@2.9.0
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## PostgreSQL without a compatibility driver

Bunqueue uses Bun 1.4's native
`SQL` pool, prepared tagged templates, reserved transactions, binary protocol,
and reconnecting `LISTEN` subscription directly. PostgreSQL 15, 16, 17, and
18 are CI compatibility targets; 18.6 is the pinned and recommended release.

## Real multi-broker coordination

Transactional `SKIP LOCKED` claims,
database-clock leases, broker-session fencing, commit-ordered durable events,
shared rate/concurrency limits, dependencies, cron, workers, job-state/lifecycle metrics, logs,
results, and DLQ state live in PostgreSQL—not in one broker's memory.

## Failure is part of the contract

Two-, four-, and opt-in ten-process
campaigns kill lease owners, reset pooled connections, race destructive
operations, reuse custom IDs, overflow retained event windows, and verify
exact recovery without duplicate delivery or stale-token commits.

## One runtime dependency

Cron parsing now uses `Bun.cron.parse()` and a
small leading-seconds compatibility adapter, so `croner` leaves the published
dependency graph and `msgpackr` is the only direct runtime package.

## Same clients, broader topology

TypeScript, Python, PHP, Go, Rust, and
Elixir run the shared protocol conformance suite against both SQLite and
PostgreSQL servers. PostgreSQL remains server-only; embedded Bun queues keep
the existing memory/SQLite path.

## What's new

- Added an optional PostgreSQL 15–18, database-authoritative storage driver for
  standalone servers, with 18.6 pinned and recommended. Multiple brokers can now share transactional job state,
  `SKIP LOCKED` claims, fenced database-clock leases, durable events, queue
  limits, cron schedules, worker registrations, logs, metrics, dependencies,
  repeat successors, and DLQ lifecycle state. A pinned two-broker
  `docker-compose.postgres.yml` topology and dedicated real-PostgreSQL
  integration suites cover the distributed path. CI now runs those suites
  against PostgreSQL 18.6 and the current 17.x, 16.x, and 15.x images;
  explicit version assertions guard every matrix entry. An additional topology
  test launches four independent bunqueue processes against one database,
  verifies exact delivery and shared policies through all endpoints, then kills
  one lease owner and proves survivor recovery plus stale-token fencing.
  An opt-in ten-process soak adds 40 concurrent consumers, 25,000-job mixed
  traffic, simultaneous loss of two lease owners, production lease timing,
  exact recovery, stale-token fencing, and PostgreSQL deadlock/WAL/temp
  accounting. Its emitted timings remain diagnostic until raw native-host
  records and integrity hashes are retained for publication.
  Two standard public-API suites additionally connect `Queue`, `Worker`,
  `QueueEvents`, and `FlowProducer` to different members of a four-process
  cluster. They cover lifecycle/results/logs, pause, custom-ID idempotency,
  DLQ retry, `removeOnComplete` result retention, zero-cache authoritative
  reads, and a three-level cross-queue flow in every PostgreSQL 15–18 CI matrix
  entry. An extreme public-API campaign adds a 256-request custom-ID collision,
  256 concurrent remote completion waiters, 32 simultaneous eight-way flows,
  and active-Worker recovery after the owning broker is killed.
- The shared SDK conformance harness can now start isolated SQLite or PostgreSQL
  brokers. TypeScript, Python, PHP, Go, Rust, and Elixir each run all 18 public
  protocol checks against both backends in CI and in the SDK sandbox. The
  sandbox provisions one disposable PostgreSQL 18.6 service on a private
  Docker-internal network and gives each broker an independently cleaned
  namespace. A case-insensitive driver policy now removes bunqueue,
  PostgreSQL/libpq, AWS/S3, storage/TLS, and delimiter-named credential
  variables while collision tests preserve non-secret toolchain settings. The
  harness observes broker exit, escalates to `SIGKILL` when required, and only
  then cleans SQLite or the PostgreSQL namespace. Startup failures follow the
  same ownership rule; every started suite settles before aggregate cleanup,
  unconfirmed container names are never force-removed, and Docker teardown
  failures remain retryable and are reported together with startup errors.
- Added `Queue.removeDlqJob(id)` and `removeDlqJobAsync(id)` for permanently
  deleting one failed job without retrying it. Both methods await the selected
  embedded or TCP broker and return whether an entry existed.
- Added 24 PostgreSQL fast-check property campaigns across six files covering arbitrary payloads,
  admission/idempotency races, scheduling and dependency ordering, competing
  claims, shared resource policies, generated lifecycle histories, fencing,
  retry/DLQ/TTL behavior, omitted progress messages, completion-proof retention,
  reverse-order generation reuse, destructive dependency safety, event convergence
  across retained and missed LISTEN windows, and generated commit orders
  independent of physical event IDs. Seeds and run counts are replayable from
  environment variables.

## Performance

- PostgreSQL multi-broker hot paths now bound journal catch-up reads at 4,096
  events and authoritative projection repairs at 1,000 IDs, remove a redundant
  autonomous queue-state insert from claims, and update exact metric buckets
  plus lifetime totals through a focused canonical-order CTE writer. Concurrent
  older transactions can no longer move metric `prevTS` or its latest-minute
  count backward. TTL expiry remains autonomous to preserve lock order, and
  SQLite behavior is unchanged.
- The native PostgreSQL runner now records broker pool size, polling interval,
  server `work_mem`, and dirty runtime-source status. A PostgreSQL 18 bottleneck
  report documents controlled code A/B evidence, 100,000-job activity sampling,
  batch/pool/`work_mem` sweeps, rejected optimizations, exact integrity totals,
  and raw artifact hashes. Batch 250 raised the four-broker lifecycle median
  from 7,478 to 8,362 jobs/s versus batch 100 with 41.7% fewer commits, while
  explicitly reporting higher command tails, WAL/job, and temporary spill.
- Added a reproducible native PostgreSQL 15–18 benchmark harness and a dated
  engineering report covering PostgreSQL 15.19, 16.15, 17.11, and 18.6 across
  one, two, and four independent broker processes. The campaign ran 84 measured
  10,000-job samples after 12 discarded warm-ups, retained exact accepted,
  invoked, and completed ID sets with zero duplicates/deadlocks/temp spill, and
  reports admission/processing/lifecycle medians, CV, Student-t CI95, command
  p95 latency, WAL per job, and broker fairness. PostgreSQL lifecycle medians
  were 6,550–6,945 jobs/s with one broker, 8,004–8,494 with two, and
  7,168–7,788 with four on the native M1 Max host.
- PostgreSQL bulk admission, claims, unique-ID ACK batches, durable events, and
  completion metrics now use set-based statements. New custom IDs and
  deduplication keys share the bulk fast path; ID/key conflicts roll the whole
  attempt back before the serial compatibility retry preserves generation reuse
  and reject/extend/replace semantics. Invalid-token ACK batches remain atomic,
  while dependent/parent admission retains its full semantic path.
- PostgreSQL push batches refresh only their affected IDs instead of reloading,
  sorting, and decoding the complete queue after every commit. Event retention
  now deletes through an indexed cutoff rather than ranking the entire journal.
  A per-ID event watch preserves a newer snapshot mutation without restarting
  the set query for unrelated or already-committed local events. This removes
  the repeated O(n) work and redundant reads that made fixed-size pushes
  super-linear.
- Default-policy PostgreSQL claimers now use compatible queue-state share locks;
  queues with rate/concurrency policy retain the exclusive lock required for
  exact shared capacity. Indexed FIFO, LIFO, group, active-group, and TTL probes
  choose a narrow-ID `SKIP LOCKED` plan before payload retrieval. Current-row
  eligibility rechecks prevent a concurrent claim from issuing a second token.
- Worker completion waves now coalesce their follow-up poll. A 64-slot Worker
  requests one 64-job `PULLB` instead of issuing 64 concurrent one-job pulls,
  preserving the same concurrency, limiter, group, lease, and SQLite behavior.
  Startup, timer, and resume polls remain immediate; only completion callbacks
  share the deferred dispatch, so already-resolved embedded query loops and
  timer ordering retain their existing behavior.
- Two native PostgreSQL 18.6 deep campaigns ran the same 180 measured samples
  across 56 scale, concurrency, batch, payload, broker, feature, and streaming
  scenarios. Each campaign submitted 696,000 jobs with exact ID conservation,
  zero duplicate invocations, and zero deadlocks. The optimized PostgreSQL
  scenarios improved by a 3.01x geometric-mean throughput factor while SQLite
  controls remained 1.00x; temporary spill fell from 6,176 files/54.97 GiB to
  zero. At 25,000 jobs PG1 lifecycle rose 309 -> 1,108 jobs/s; custom-ID and
  deduplication batch admission rose ~31 -> 8,414/8,244 jobs/s. These native,
  non-quiesced results are engineering evidence, not published cross-project
  claims.
- A two-broker `pg_stat_statements` campaign with 16 claim loops and 20,000 jobs
  measured 11,749 admission, 9,782 processing, and 5,338 lifecycle jobs/s with
  exact delivery, zero deadlocks, and zero temp files. Against the pre-claim
  profile, processing improved 3.06x and lifecycle 2.24x; queue-state lock time
  fell from 88.4 s aggregate to 3.5 ms, and 200 push batches now issue exactly
  200 affected-ID reads instead of roughly 380. A separate 21-instance safe-settings
  matrix (420,000 jobs) found only a host-specific +6.3% median at
  `shared_buffers=512MB`; AIO/JIT/WAL variants were close enough that bunqueue
  does not impose server-wide tuning or weaken PostgreSQL durability.
- A final 60-sample/18-scenario end-to-end subset submitted 423,000 jobs per
  compared campaign and improved another 1.16x geometrically over the first
  optimized PostgreSQL pass. PG1/PG2 at 25,000 jobs reached 1,569/2,078 jobs/s,
  four brokers reached 2,428 jobs/s at fixed total concurrency, and every sample
  retained exact delivery with zero duplicates/deadlocks. Five focused final
  samples measured 8,635 custom-ID and 8,212 deduplicated admissions/s. SQLite
  controls ran the unchanged engine and measured 0.96x on the non-quiesced host.
- A post-watermark native run used one warm-up plus five fresh 10,000-job samples
  for SQLite, one PostgreSQL broker, and two PostgreSQL brokers. Median lifecycle
  rates were 767, 1,986, and 2,638 jobs/s respectively, with 1.5%, 0.5%, and 0.6%
  variation. Every sample completed the exact accepted ID set with zero duplicate
  invocations; these remain local diagnostic measurements.
- The final commit-envelope journal repeated the same native protocol after the
  commit-order fix. SQLite/PG1/PG2 median lifecycle rates were 763/1,868/2,474
  jobs/s with 1.3%/0.4%/1.4% variation. The immutable-envelope design improved
  PG1/PG2 by 16.8%/26.0% over the first correct hot-row sequencer, retained exact
  10,000-ID delivery and zero duplicates, and left SQLite on its unchanged path.
- The compatibility-final candidate repeated the native one-warm-up/five-sample
  protocol after queue-refresh retry and health reporting were complete.
  SQLite/PG1/PG2 median lifecycle rates were 717/1,552/2,218 jobs/s with
  1.7%/1.5%/3.9% variation on the non-quiesced host. Every 10,000-job sample
  retained exact ID conservation and zero duplicates; the two PostgreSQL brokers
  split work 4,992/5,008 or 5,008/4,992.
- A focused post-lock-order native campaign made two stores submit the same
  10,000 custom IDs in opposite 500-job batches. Across one warm-up and five
  fresh PostgreSQL 18.6 samples, median time was 2,271.9 ms: 4,402 unique durable
  jobs/s or 8,803 attempted admissions/s with 1.7% variation. Every sample kept
  exactly 10,000 rows with zero errors and zero deadlocks.
- The final generation-lifecycle candidate repeated the native lifecycle
  campaign after review fixes. SQLite/PG1/PG2 medians were 759/1,792/2,335
  jobs/s across five fresh 10,000-job samples per topology, with
  0.5%/0.6%/1.0% variation. PostgreSQL admission medians were 9,922/9,465
  jobs/s. Every sample retained exact accepted/invoked/unique/terminal ID
  conservation, zero duplicates, and balanced two-broker processing.
- The final queue-lifecycle, durable Cloud read-model, and post-commit
  maintenance candidate repeated that native campaign. SQLite/PG1/PG2 medians
  were 766/1,733/2,276 jobs/s across five fresh 10,000-job samples per topology,
  with 1.1%/0.9%/1.9% variation. PostgreSQL admission medians were 9,622/9,372
  jobs/s. All samples retained exact accepted/invoked/unique/terminal ID
  conservation and zero duplicates, and both PostgreSQL brokers processed work
  in every two-broker sample.
- The final event-retention candidate repeated the native one-warm-up/five-sample
  protocol after the contention fix. SQLite/PG1/PG2 lifecycle medians were
  750/1,525/2,492 jobs/s with 0.1%/0.4%/1.8% variation; enqueue medians were
  4,321/9,121/8,492 jobs/s. All 150,000 measured jobs preserved exact accepted,
  invoked, unique, and terminal ID sets, zero duplicates, and two-broker
  participation with PostgreSQL durability fully enabled.
- The shutdown-drain and DLQ-repair candidate repeated that full native
  campaign after the final lifecycle changes. SQLite/PG1/PG2 lifecycle medians
  were 722/1,366/2,357 jobs/s with 1.4%/1.0%/2.1% variation; enqueue medians
  were 4,207/7,708/7,960 jobs/s, and PostgreSQL processing medians were
  1,641/3,376 jobs/s. All 150,000 measured jobs preserved exact accepted,
  invoked, unique, and terminal ID sets with zero duplicates, and both brokers
  participated in every PostgreSQL two-broker sample.
- The completed lifecycle-gate and atomic-child-removal candidate repeated the
  same native campaign. SQLite/PG1/PG2 lifecycle medians were
  738/1,462/2,530 jobs/s with 0.6%/2.3%/1.6% variation; enqueue medians were
  4,309/8,639/8,425 jobs/s, and PostgreSQL processing medians were
  1,756/3,617 jobs/s. PostgreSQL lifecycle medians improved by 7.0% and 7.3%
  over the immediately preceding one- and two-broker candidate. All 150,000
  measured jobs retained exact accepted, invoked, unique, and terminal ID sets,
  zero duplicates, and two-broker participation with full PostgreSQL 18.6
  durability.

## Compatibility notes

- PostgreSQL must be selected explicitly by driver or URL, cannot share a
  configuration with a SQLite data path, and uses normal PostgreSQL backup/PITR
  tooling rather than bunqueue's SQLite S3 snapshots. MySQL is not supported in
  2.9.0.
- The supported cron grammar remains standard five-field syntax plus bunqueue's
  documented leading-seconds six-field form. Seven-field years and the
  undocumented Croner extensions `L`, `W`, `#`, `+`, and `?` now fail validation
  instead of being accepted accidentally. Bun's DST rules are now explicit:
  missing spring-forward fixed times shift by the gap; fall-back fixed times
  fire once at their first occurrence, while wildcard minute/hour schedules
  traverse both occurrences. The latter intentionally differs from Croner for
  some repeated-hour schedules and is covered for both five and six fields.
  Before upgrading, replace or remove persisted schedules that use the rejected
  Croner extensions while a 2.8 broker is still running. Version 2.9 validates
  the complete persisted collection before advancing any missed schedule and
  reports the offending name and schedule instead of silently omitting it.
  Interval definitions likewise require a positive safe-integer `repeatEvery`
  in milliseconds across public and persisted paths. Invalid input now fails before
  scheduler, deduplication, or database mutation; a valid calendar schedule
  retains precedence when both timing fields are present.
- PostgreSQL requires `maxQueueEvents >= 1` because retained durable events are
  part of multi-broker convergence. Memory and SQLite retention behavior is
  unchanged.

## Changes

- Dedicated PostgreSQL test commands now reject a missing or blank
  `BUNQUEUE_TEST_POSTGRES_URL` instead of exiting successfully after skipping the
  database suite. Explicit smoke, destruction, pressure, and full battle
  profiles make the production gate repeatable; battle mode enables the
  ten-broker failure soak and raises every Fast Check campaign to 100 runs. New
  connection-reset regressions terminate every pooled backend for two brokers,
  require stable-ID retry plus projection convergence, and kill an admission
  after its job write to prove transactional rollback and exact retry. Spawned
  broker diagnostics now drain bounded stdout and stderr captures, classify both
  human and JSON records, and wait for process exit plus stream EOF before the
  ten-broker gate asserts that no ACKB failure was hidden. Stream read errors and
  missing EOF now cancel the remaining pipes but reject the diagnostic gate, so
  an incomplete capture cannot produce an authoritative zero-failure result.
- PostgreSQL schema v17 moves every advisory-lock domain to unambiguous,
  length-prefixed 64-bit identities. Multi-key admission, dependency, flow, and
  queue-lifecycle plans deduplicate and order the physical lock keys. Destruction
  and pressure profiles now include deterministic legacy-hash collisions,
  bounded core-transaction rollback/replay, retry diagnostics, and the existing
  ten-process broker-crash soak.
- The deployment guide now includes a production-oriented Kubernetes manifest
  for four PostgreSQL-backed brokers, with unique Pod-derived broker identities,
  database startup gating, storage-aware probes, graceful termination, connection
  budgeting, coordinated non-mixed-version upgrades, and a Pod disruption
  budget. A fresh Kubernetes 1.33.1/kind failure campaign against PostgreSQL
  18.6 verified cross-broker jobs and Flow execution, forced lease-owner loss,
  stale-token fencing, recovery, and automatic Pod replacement.
- PostgreSQL documentation now distinguishes the CI-tested 15–18 compatibility
  range from the pinned/recommended 18.6 deployment, documents broker
  heartbeat/takeover/recovery timing, Bun SQL pool lifecycle deadlines, safe
  schema upgrade and rollback boundaries, backend-specific durability/health
  semantics, and separate SQLite/PostgreSQL sizing. The public benchmark guide
  now includes the multi-broker version and tuning campaigns, and publishes the
  seven exact raw JSON artifacts with a SHA-256 manifest.
- The README, documentation home, storage/deployment guides, FAQ, security
  guidance, architecture pages, and social covers now describe the exact
  SQLite-versus-PostgreSQL topology consistently. A full documentation audit
  scopes performance headlines to their measured workloads, corrects the Cloud
  payload and remote-command defaults, validates internal and external links,
  and publishes a warning-free v2.9 TypeDoc reference while retaining v2.8 as
  a noindex historical tree.
- PostgreSQL uses Bun 1.4.0's built-in `SQL` client directly; no ORM or external
  PostgreSQL compatibility driver sits on the queue hot path. The implementation
  uses its native pool, binary protocol, prepared tagged templates,
  transaction-reserved connections, and reconnecting LISTEN subscription against
  PostgreSQL 18.6.
- Cron calendar, timezone, POSIX day matching, and DST evaluation now use Bun
  1.4.0's native `Bun.cron.parse()` API. A focused compatibility adapter keeps
  bunqueue's documented six-field syntax by parsing the leading seconds field,
  including lists, ranges, and steps, while the scheduler and SQLite/PostgreSQL
  persistence paths remain unchanged. `croner` is no longer a published runtime
  dependency, leaving `msgpackr` as the only one. Seven-field years and the
  previously accidental `L`, `W`, `#`, `+`, and `?` Croner extensions are now
  rejected explicitly because they were never part of bunqueue's public grammar.
- Memory and SQLite remain the inferred/default backends and retain their
  synchronous behavior. PostgreSQL is selected only from an explicit driver or
  URL, is server-only, cannot be combined with a SQLite data path or SQLite S3
  snapshots, and does not imply MySQL support. Explicit `memory` construction
  ignores an inherited SQLite data path; the SQLite Strategy and hot path remain
  unchanged.
- PostgreSQL `WaitJob` now recognizes durable completion-only generations when
  a queued request reaches the broker after `removeOnComplete` deleted the live
  row. A discriminated asynchronous completion port preserves valid
  `undefined` results, performs one authoritative PostgreSQL read, and leaves
  the existing memory/SQLite missing-row behavior unchanged.
- PostgreSQL `IsPaused` now reads durable queue state after pause/resume instead
  of relying on the eventually consistent local projection. This closes the
  commit-to-LISTEN read-your-write window seen by every network SDK while
  preserving the existing synchronous memory and SQLite path.
- Server persistence selection now uses explicit Strategy, immutable Registry,
  and lifecycle Facade boundaries. Fake adapters unit-test validation, creation,
  display, concurrent shutdown coalescing, and retry after transient shutdown
  errors; PostgreSQL feature code remains split into focused transaction scripts
  with explicit SQL contexts behind its store Facade and Snapshot read model.
  Dependency completion uses an immutable Lock Plan/Command, while event health,
  bounded startup capture, and deferred write serialization are independent
  components. Failure and race paths can therefore be exercised without coupling
  every test to server bootstrap.
- Cloud command and snapshot selection now uses its own complete Strategy and
  cached Registry. Memory/SQLite delegates to the existing local behavior;
  PostgreSQL shared jobs, counts, queue configuration, lifetime terminal totals,
  results, logs, workers, crons, and leases come from durable APIs and one
  bounded `REPEATABLE READ READ ONLY` snapshot. There is no silent per-method
  fallback to a broker's compatibility cache.
- PostgreSQL completion evidence is now generation-scoped and bounded. Live
  dependency proofs are pinned, unreferenced `removeOnComplete` tombstones keep
  the newest `maxCompletedJobs`, the compatibility snapshot independently caps
  completed rows and its `maxJobResults` LRU, and schema v15 adds the queue/recent
  completion indexes plus durable queue-registry backfill. Tombstone cleanup
  commits in 1,000-row batches until it reaches the exact bound, runs before
  startup readiness, retries post-commit failures, and has a periodic repair
  sweep for interrupted cleanup or configuration reductions. PostgreSQL rejects
  `maxQueueEvents: 0` explicitly because multi-broker convergence needs at least
  one durable event; SQLite and memory behavior is unchanged.
- The full unit suite now uses Bun 1.4 file parallelism with four isolated
  workers in the local package script, disposable Docker sandbox, and GitHub
  Actions. The shared configuration is covered by a repository gate to prevent
  the three entry points from drifting.
- PostgreSQL Fast Check cleanup now deletes all generated namespaces per scope
  in one set-based transaction and gives database hooks an explicit deadline,
  so deep campaigns preserve isolation without exhausting pools or timing out
  after otherwise successful properties.
- PostgreSQL cron overlap coverage now waits for durable `next_run` using the
  database clock and permits either broker to win the row lock, eliminating a
  host-timing race with automatic maintenance without weakening execution-limit
  assertions.

## Bugfixes

- PostgreSQL Prometheus per-queue gauges and exported/omitted cardinality now
  read the bounded local PostgreSQL projection instead of the unused
  SQLite/in-memory cache. Cross-broker values converge through the committed
  event stream and polling repair.
- PostgreSQL atomic flow admission no longer repeats an admission lock, clock
  read, completion scan, queue registration, and full event-retention cycle for
  every graph node. `PUSHF` now reuses its complete outer lock plan, samples one
  post-lock transition timestamp, and batches ordered `pushed` events plus queue
  registration while preserving one transactional graph. A nine-job durable
  regression proves all rows, eight edges, two queue identities, event order,
  initial states, and timestamps; a forced `55P03` replay proves no duplicate
  timeline, edge, or event.
- PostgreSQL core admission, claim, ACK, ACKB, and FAIL operations now replay
  once with jitter after rollback-certain `40001`, `40P01`, or `55P03` errors.
  Connection and statement-cancellation failures are never guessed or replayed.
  Regressions hold the deferred event-commit lock through the first attempt and
  prove exact job, result, event, metric, and timeline state; retry exhaustion
  remains bounded and leaves no partial transition.
- PostgreSQL advisory locks no longer alias distinct client-controlled job IDs,
  deduplication keys, flow parents, or queue names through 32-bit `hashtext`
  collisions. Fixtures verified across PostgreSQL 15–18 prove both same-identity
  exclusion and independence for colliding dependency IDs and queue names.
  Exhausted ACKB infrastructure errors stay redacted on the wire while bounded
  local logs retain SQLSTATE and trigger-location diagnostics.
- PostgreSQL schema initialization now validates the exact unique, key, access
  method, and live-state predicate semantics of
  `bunqueue_jobs_live_unique_key_idx`. A weaker same-name index is rebuilt in
  the migration transaction, while pre-existing duplicate live keys fail closed
  and roll back without mutating data or leaving a partial repair.
- SQLite DLQ and completed retries now restore live custom-ID and unique-key
  ownership. Every DLQ retry variant persists before publishing RAM, rejects a
  key owned by another generation without dropping terminal work, and leaves
  memory plus disk unchanged after a storage failure. The minimized model seed
  that exposed the bug is retained as a deterministic regression.
- PostgreSQL `GetResult` and `WaitJob` now read completion results through an
  asynchronous authoritative result port. A broker waiting on work completed
  by another broker can no longer return `completed: true` with an undefined
  result before its local projection refreshes. PostgreSQL waits register a
  cancellable event waiter before rechecking the completion table, closing the
  check-before-subscribe race without polling; memory and SQLite retain their
  existing synchronous result behavior.
- PostgreSQL DLQ creation now derives entry, attempt, retry, and expiry
  timestamps from the transaction's database clock. Age maintenance no longer
  compares a broker-host timestamp with PostgreSQL time, which could delay a
  short `maxAge` purge when the broker clock was ahead. A deterministic
  multi-broker regression advances the broker clock by 60 seconds and proves
  exact purge plus invalidation convergence; memory and SQLite keep their
  existing clock behavior.
- PostgreSQL authoritative queue refreshes now fence older in-flight per-job
  projections immediately before replacing the local read model. Completion
  projections retain the queue identity stored in PostgreSQL instead of an
  optional caller hint, so a remove-on-complete result cannot be assigned to an
  empty queue and survive or reappear after a concurrent multi-broker
  `obliterate`. Deterministic generation tests and repeated PostgreSQL 16
  regressions cover both the stale-read ordering and queue ownership. Memory and
  SQLite behavior remain unchanged.
- PostgreSQL production hardening now session-fences every broker process.
  Duplicate live `brokerId` values fail startup; stale takeover installs a new
  internal session, and old shutdown/heartbeat/claim/renew/worker operations
  cannot affect successor leases or rows. Schema v16 adds session columns and
  exact cleanup indexes. Bun SQL connections now set statement, lock, and idle
  transaction deadlines; the manager bounds active/queued operations and fails
  fast on saturation. Manager/queue snapshots reject explicit job or payload
  budgets before decoding instead of risking an unbounded allocation. Startup
  lifetime metrics finalize against the durable commit sequence, adaptive
  journal GC drains sustained envelope backlogs, and same-key post-commit
  maintenance is serialized and coalesced without overlap. The default pool is
  four connections per broker, CI covers PostgreSQL 15–18, and SQLite behavior
  remains unchanged. Concurrent broker startup now elects one oldest live
  session under the cron advisory lock, so every broker cannot simultaneously
  skip missed-schedule reconciliation.
- PostgreSQL lifecycle and asynchronous concurrency now separate committed
  database outcomes from fallible local projections. Push, flow, ACK/fail,
  queue control, maintenance, and relationship mutations keep their committed
  result while a generation-fenced projection scheduler reports and retries a
  failed read. Historical journal payloads no longer overwrite a newer local
  claim or clear its token; only an authoritative current row can do so. Unique
  projection-flight identities preserve stale-read fencing while settled
  generation entries are reclaimed instead of growing once per historical job.
  Bootstrap and per-queue views use coherent `REPEATABLE READ READ ONLY`
  snapshots, startup overflow retries are bounded, and queue refresh cannot
  keep shutdown in an unbounded quiet-window loop. Client lease release retains
  exact token sessions and cumulative progress across retries. Periodic work is
  single-flight per subsystem, and store shutdown drains all admitted periodic
  and post-commit maintenance before releasing broker resources or closing the
  SQL pool. Memory and SQLite code paths are unchanged.
- PostgreSQL shutdown now uses one reentrant lifecycle gate for database-backed
  admissions, batch/flow pushes, individual claim attempts, durable mutations
  and reads, startup hydration, and synchronous deferred writes. Operations
  admitted before shutdown drain through their final snapshot refresh, while
  late or escaped work fails before reaching the closed pool. Empty long-polls
  no longer hold shutdown open, and late disconnect cleanup remains local and
  idempotent. A committed operation can therefore no longer return a pool-close
  error merely because another caller started shutdown.
- PostgreSQL `removeUnprocessedChildren` now removes direct pending children in
  one canonically locked transaction. A fixed-point consumer analysis retains
  and detaches children required by surviving jobs, while waiting,
  prioritized, delayed, and safe waiting-children generations are deleted with
  exact durable events. Active and terminal children preserve leases, results,
  completion evidence, and DLQ state. The command is idempotent across brokers;
  the existing synchronous SQLite implementation and behavior are unchanged.
- PostgreSQL event retention now uses non-blocking per-queue locks on inline
  writers, deterministic tuple locking, and commit-aware autonomous sweeps.
  Same-queue completion contention and inverse multi-queue write orders no
  longer produce `40P01` deadlocks, while a fresh post-commit snapshot converges
  the retained journal to its exact configured bound. Queue obliteration takes
  lifecycle then retention ownership before job rows and deletes event history
  before its watermark, closing the manual-trim inversion as well.
- Preserved Cloud `queue:detail` responses for SQLite queues that only have
  configuration state and no jobs. The async adapter now requests the named
  queue explicitly, so `stallConfig.enabled` and the remaining configured
  values do not fall back to defaults.
- Cloud job pagination now uses one half-open range contract across SQLite and
  PostgreSQL, with normalized non-negative limits and offsets. Regular remote
  commands and `snapshot:get` retain raw infrastructure details in local logs
  but redact them from dashboard responses.
- PostgreSQL admission and queue deletion now share a queue-lifecycle lock
  domain. Admissions take compatible shared transaction locks; `obliterate`
  takes the exclusive lock before queue state, discovers candidates inside the
  transaction, and removes only the generation committed before its
  linearization point. Repeat ACKs use a late try-lock and roll back atomically
  on conflict, preventing deadlocks and split successor chains. Queue identity
  survives final-job removal and restart without phantom registrations from
  duplicate IDs.
- Completion/DLQ pruning now runs through a keyed post-commit maintenance
  executor. A committed ACK/FAIL/discard is never reported as rejected because
  idempotent retention failed; health stays degraded, failed work is coalesced
  and retried, and invocation-identity fencing prevents a late success or failure
  from deleting or reporting for newer work after a key is reused. Shutdown now
  closes maintenance admission without touching an already closed pool and
  drains terminal operations admitted before shutdown through their final
  snapshot refresh. Startup and periodic DLQ sweeps repair skipped retention
  using the current queue policy under lock and remain idempotent when multiple
  brokers run them concurrently. DLQ auto-retry now locks current policy and the
  complete consumer/dependency identity plan before failed rows, revalidating
  edges after lock waits so dependency custom-ID reuse cannot promote a consumer
  from stale completion evidence. Four concurrent brokers still emit one retry.
- Server shutdown now runs through a memoized coordinator. Duplicate signals
  share one task, optional backup/Cloud failures cannot skip storage cleanup,
  transient storage close is retried once with a timeout, and permanent failure
  exits non-zero instead of recursing into an already-guarded rejection handler.
- PostgreSQL list ordering now uses binary ID comparison, an empty state array
  means all states, repeated lease renewal refreshes expiry/heartbeat/TTL/count,
  and durable completed/failed totals survive removal, clean, purge, and broker
  restart. Local worker lifetime processed/failed totals now survive worker
  unregistration.

- PostgreSQL destructive writers now share dependency identity locks with
  admission. Cancel/remove, clean, TTL, drain, DLQ limit/expiry/purge, terminal
  retry, `removeOnFail`, protected-cron cleanup, dedup replacement, and
  obliterate revalidate candidate/live-consumer rows and cannot leave a live
  `waiting-children` job without either its producer row or completion proof.
  Queue obliteration also removes completion-only rows and rejects external live
  consumers. New deterministic and Fast Check campaigns cover both lock orders,
  all adapters, custom-ID generation reuse, four brokers, and schema 13-to-15
  migration.
- Reusing a custom ID after `removeOnComplete` now retires the old completion
  before inserting the new generation on both serial and set-based batch paths.
  Serial admission resolves deduplication first, so a candidate that returns a
  different owner preserves its completion-only or retained terminal generation.
  Reverse-order batches exempt only consumers inserted in the same transaction,
  reconcile every surviving row against final proof, and correct the original
  `pushed` payload without reordering `pushed`/`removed`. Late-ID replacement
  retains its non-blocking identity probe, while fast-path conflicts roll back
  before completion retirement and enter the selective serial path.
- PostgreSQL progress updates now preserve the previous message when the next
  update omits `message`, matching the unchanged SQLite contract. Awaited and
  deferred disconnect cleanup also freezes every `(jobId, token)` before its
  first asynchronous boundary, so delayed work cannot release or forget a
  newer custom-ID generation.

- PostgreSQL dependency validation now reaches the authoritative database when
  a receiving broker's event snapshot lags, and admission reasserts job or
  completion evidence inside the write transaction under the canonical
  dependency locks. Immediate broker-A-to-broker-B `PUSH`/`PUSHB`, reverse-order
  same-batch parents, removal between preflight and admission, and a planned
  parent deduplicating to another ID are covered without orphan jobs or partial
  commits.
- PostgreSQL health errors now make HTTP health/readiness, WebSocket health, and
  `bunqueue_storage_degraded` report degradation even when the failure is not a
  full disk. Client-facing health, storage-status, dashboard, MCP, and Cloud
  payloads redact non-disk SQL/network diagnostics while preserving the existing
  actionable SQLite disk-full response. Local handler catches and the outer HTTP
  boundary use the same sanitizer, and dependency reads no longer turn database
  errors into successful empty maps.
- Failed-job `MoveToWait` now dispatches to PostgreSQL's durable DLQ retry while
  retaining the synchronous SQLite path. PostgreSQL dashboard commands, HTTP
  dashboard and per-queue worker routes, and WebSocket/SSE stats snapshots now
  read the shared worker and cron registries instead of one broker's local maps.
- The root CI quality gate now explicitly requires the PostgreSQL 18.6/17/16/15
  compatibility job, preventing build and release jobs from proceeding after a
  failed or cancelled database matrix.
- PostgreSQL single and bulk admission now lock the complete custom-ID and
  deduplication-key union in one canonical set-based order. Two brokers can
  submit the same 500 IDs in reverse order without a `40P01` deadlock. Dynamic
  parent attachment, explicit failure, detach, and expired-lease recovery also
  share the child relationship lock, re-read its current parent, and acquire
  sorted parent locks before job rows, closing the terminal attachment TOCTOU
  window.
- PostgreSQL rate limits now normalize non-positive duration and TTL values
  exactly like SQLite: the duration uses the one-second default and the TTL is
  permanent. Periodic health is tracked per subsystem, so a successful heartbeat
  cannot erase a persistent recovery, DLQ, cron, event-stream, or queue-refresh
  failure.
- PostgreSQL job-log writes and retention now serialize on the owning job row.
  Concurrent writers retain the exact requested maximum, and a concurrent
  removal cannot leave an orphan log. Protocol error boundaries also redact
  PostgreSQL SQLSTATE, constraint, driver, host, SQLite, and network diagnostics
  while preserving intended domain errors.
- The PostgreSQL Compose topology no longer interpolates the raw
  `POSTGRES_PASSWORD` into broker URLs. Operators provide a separately
  percent-encoded `BUNQUEUE_POSTGRES_URL`, with a valid default for local use.
- The disposable unit-test image now includes the PostgreSQL Compose manifest,
  allowing its credential-safety regression to run inside the mandatory
  network-isolated sandbox as well as on the host.
- PostgreSQL queue obliteration now locks shared queue state before job rows,
  matching the claim hierarchy and preventing a deterministic multi-broker
  deadlock. Completion snapshots also discard stale results after retry, clean,
  removal, and custom-ID generation reuse.
- PostgreSQL DLQ size eviction and age expiry now publish one transactional
  queue invalidation per affected queue. Live invalidation markers are applied
  independently of journal retention and deduplicated during replay. Terminal
  and retry events now carry complete DLQ entry/retry state, and pruning writes
  its invalidation after the terminal event so cursor replay retains it. Remote
  DLQ lists, entries, counts, and stats therefore converge even after a missed
  notification with a one-event queue-event window.
- PostgreSQL schema v13 adds a deferred commit sequencer for the transactional
  event outbox. A namespace transaction advisory lock plus a global `CACHE 1`
  sequence preserves same-namespace commit order. Immutable event rows reference
  a compact per-transaction commit envelope, avoiding a second event rewrite and
  its index/WAL amplification; unreferenced envelopes are collected safely.
  Brokers upgrade v12 in place, reject a newer recorded version, verify the exact
  semantics of every correctness-critical journal object before the no-DDL fast
  path, and repair detected drift under the migration advisory lock. The guard
  covers sequence properties, column definitions, ordered indexes/predicates,
  trigger bindings, and normalized function bodies while preserving index object
  IDs on a healthy schema.
  This prevents both startup DDL deadlocks and silent replay with a missing
  trigger or index.
- PostgreSQL broker/client shutdown and recovery preserve lease fencing across
  pooled cross-broker heartbeats, discard protected cron leases instead of
  resurrecting overlap work, and reconcile missed cron slots only when no other
  active broker owns the namespace. Distributed lifecycle deadlines use the
  database clock to tolerate broker clock skew.
- PostgreSQL event replay now polls the durable outbox by `(commit_seq, event_id)`
  and treats LISTEN/NOTIFY only as a wake-up. Pre-commit envelope stamping is
  abort-safe and independent per namespace, so a lower physical ID committed
  late cannot be skipped. Drain
  requests are bounded/coalesced; failures remain visible in health until a
  complete durable scan succeeds.
- PostgreSQL event pruning now records a transactional per-queue durable
  watermark with a cumulative monotonic pruned-commit frontier. Brokers that
  missed discarded single or batch history refresh only the affected queue,
  while already-current brokers keep the incremental path; no global
  `BIGSERIAL` gap heuristic or synthetic public event is used. Manual trim now
  derives that frontier from deleted commit envelopes and does not invalidate an
  already-current broker.
- PostgreSQL dependency completion now promotes every newly ready parent in the
  same transaction as ACK/ACKB, including `removeOnComplete`, payload timeline,
  state, version, and durable event. Canonically ordered dependency and parent
  locks close concurrent fan-in and late-consumer admission races; claim-time
  promotion remains an idempotent repair path.
- PostgreSQL snapshot startup now uses a bounded 256-event accumulator across
  initial hydration and retries the authoritative load after overflow, and
  every point/batch refresh—including stale null reads—uses the same per-job
  version fence. Deduplication replace/expiry/extend transitions publish atomic
  cache updates, so remote brokers cannot retain an obsolete generation, unique
  key, TTL, result, or lifecycle state. Failed queue invalidation refreshes now
  preserve their dirty marker and retry with bounded backoff instead of silently
  leaving a broker with only the retained journal subset. Their per-queue errors
  remain visible in storage health until success, and shutdown stops persistent
  retry loops.
- PostgreSQL worker heartbeat and unregister operations are fenced by the
  current broker and connection owner. A stale connection cannot overwrite or
  delete a worker re-registered elsewhere. Deferred compatibility writes retain
  ordered failures until flush. Concurrent flushes at the same sequence share
  one checkpoint and observe the same errors; shutdown drains them before
  reporting an error.
- PostgreSQL manager/store shutdown is coalesced for concurrent callers and
  retryable after a transient cleanup error. Lease, worker, broker, event, and
  SQL-pool cleanup steps are tracked independently; adapter ownership is removed
  only after the complete attempt succeeds.
- Selective DLQ deletion is now restart-safe and complete. It propagates broker
  failures, closes the discard/removal persistence race, removes all recovered
  duplicate rows, and releases terminal custom-ID, dependency-result,
  result/log, job-index, and flow-failure ownership.

---

[← bunqueue v2.8.61](/blog/bunqueue-v2-8-61/) · [Full changelog](/changelog/) · [All posts](/blog/)
