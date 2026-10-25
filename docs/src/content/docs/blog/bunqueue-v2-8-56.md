---
title: "bunqueue v2.8.56"
description: "Made durable acceptance fail closed in Embedded and real TCP+SQLite modes."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-56.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-08-03"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.56</em></h1>
  <p class="bq-hero-sub">Made durable acceptance fail closed in Embedded and real TCP+SQLite modes.</p>
</div>

:::caution
The changelog marks this release as "do not use". Install a later version instead.
:::

#### To install bunqueue v2.8.56

```bash title="bun"
bun add bunqueue@2.8.56
```

```bash title="npm"
npm install bunqueue@2.8.56
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Engine correctness

- Made durable acceptance fail closed in Embedded and real TCP+SQLite modes. A
  synchronous SQLite rejection, including a full disk, now leaves no
  executable, queryable, counted, or identity-owning RAM-only job after single
  or bulk adds. The broker plans custom-ID retirement, dedup replacement,
  dependency-completion pins, and parent linkage without destructive mutation;
  commits the required rows atomically; and only then publishes queue/index
  state. A rejected completed/DLQ ID reuse preserves the previous generation
  and result across restart, a rejected parent link exposes no half-edge, and
  ordered bulk accepted-prefix behavior is unchanged. Deterministic fault
  injection and real bounded-filesystem regressions cover both transports.
- Made deduplication replacement atomic across the heap, `jobIndex`, unique-key
  ownership, counters, and SQLite. Replaced durable jobs no longer remain
  queryable or resurrect after a broker restart, and generation-safe cleanup
  cannot delete the replacement's key.
- Made Worker limiter admission atomic at job start. Concurrent and batched
  workers now acquire the rate token before processor fan-out instead of after
  completion, so `max`/`duration` is enforced for every concurrency value.
- Separated the public job name from user data in the domain model, SQLite, and
  protocol v3. Embedded, TCP, MCP, list, worker, DLQ, Flow, and all six external
  SDKs now preserve `job.name` without adding or consuming `data.name`, while
  schema migrations retain a bounded fallback for legacy name envelopes.
- Populated `returnvalue` and `failedReason` consistently on embedded and TCP
  reads, preserving `null` and every falsy result. Worker retention options now
  apply remotely, DLQ statistics include `byQueue`, and the async filtered DLQ
  retry returns the authoritative broker count.
- Made completed-job retry an atomic durable generation transition. The broker
  now resets attempts, progress/message, processing/completion timestamps, and
  heartbeat and deletes the prior result in the same SQLite transaction before
  publishing the waiting state. Neither stale `returnvalue` nor completed
  metadata can remain visible or resurrect after restart; stacktrace and
  timeline history are intentionally preserved.
- Fixed store-and-forward shutdown after a forced connection-pool close. Queued
  durable commands now settle deterministically instead of failing with
  `Connection pool is closed` during recovery or teardown.
- Made late outcomes from lock-expired `preventOverlap` cron generations
  idempotent. The engine records the exact retired lease in a bounded map, so
  embedded single ACK and TCP batch ACK stop retrying after the cron job is
  deliberately discarded, while wrong tokens, arbitrary missing jobs, and
  duplicate ACKs against completed jobs remain errors. SQLite deletion and
  custom-ID reuse retain their existing generation safety.
- Made processing timeouts authoritative over every late processor outcome.
  The timeout transition records the exact `{ jobId, startedAt, token }` while
  owning the processing claim. A later ACK, FAIL, manual `moveToFailed()`, or
  sandbox result for that retired generation returns structured ignored
  evidence and emits no false local `completed`, `failed`, or Worker `error`
  event. Batch ACK evidence includes exact positions, including duplicate IDs;
  a retry's current token still applies and wrong/missing tokens still reject.
- Replaced the placeholder queue metrics/event APIs with a durable per-queue
  implementation. `getMetrics()` now returns bounded, newest-first one-minute
  completed/failed series with real pagination and cumulative counters;
  `trimEvents()` trims a separate bounded lifecycle journal and returns the
  exact idempotent removal count. SQLite restart, queue isolation, concurrent
  batch completion, retries, obliterate, embedded and TCP paths share the same
  contract.
- Fixed `Queue.add({ repeat: { pattern } })` creating zero-delay successors and
  starving the runtime. Completion-chained repeats now use the authoritative
  cron parser, preserve timezone/date/window/limit and compatible job policies,
  apply positive/negative offsets without skipped or past deadlines, retain
  `updateData()` propagation, and continue across SQLite-backed broker restarts.
  Interval offsets establish a future first-successor phase without making
  `immediately` recur. Schema v34 persists repeat and advanced generation
  policy in `jobs.extended_options`; ambiguous parent/dependency and outer
  custom-ID combinations are rejected atomically in embedded and TCP modes.
- Completed legacy FlowProducer metadata parity. Chain and parent-first tree
  descendants now persist the exact `__parentId` / `__parentQueue` alongside
  `__flowParentId`, including cross-queue and restart recovery. Worker,
  `getJob`, and list reads expose engine-owned `FlowJobData` without
  reintroducing the historical name envelope. Flow `updateData()` atomically
  preserves every topology field, rejects reserved-key forgery over embedded
  and raw TCP paths, and still permits unrelated `__custom` keys on ordinary
  jobs.
- Made `FlowProducer.closing` meaningful and failure-safe: it is `null` while
  live, becomes the single Promise installed by the first close/disconnect,
  releases its connection ownership once, and remains stable after resolution
  or rejection.
- Replaced the five-second processing-timeout sweep with an active-job
  next-deadline scheduler. Short timeouts now fail near `startedAt + timeout` in
  embedded and TCP modes; concurrent deadlines remain ordered, late ACKs retain
  retry safety, and timers beyond the signed 32-bit runtime ceiling are chunked
  without overflow. ACK/FAIL, manual moves, disconnect/stall/lock recovery,
  cleanup, obliterate, custom-ID generation reuse, and shutdown all invalidate
  stale deadline entries.
- Made mixed FIFO/LIFO ordering total at equal priority: LIFO jobs form a
  newest-first partition ahead of FIFO jobs, while numeric priority remains the
  authoritative first key.
- Made `Queue.add({ parent: { id, queue } })` and `addBulk()` create durable,
  atomic dependency edges to existing pending parents in embedded and TCP
  modes, including cross-queue and restart recovery. Bare protocol `parentId`
  forward references remain compatible with legacy flow construction.
- Preserved complete `SchedulerInfo` values from `upsertJobScheduler()` in both
  embedded and TCP modes: immediate results now retain `pattern`/`every` and
  use the exact scheduler or broker `nextRun` value instead of approximating
  pattern schedules as a 60-second interval.
- Made `getJobSchedulers(start, end, asc)` apply its documented list contract
  in both modes. Results are ordered by next execution time, equal deadlines
  use scheduler IDs as a deterministic tie-breaker, ranges are zero-based and
  inclusive, `end: -1` reads the remainder, and `asc` defaults to `false`.
- Chunked cron timers at the runtime's signed 32-bit timeout ceiling while
  retaining the absolute persisted `nextRun`. Yearly and other far-future
  schedules no longer collapse to a 1ms hot loop or flood overflow warnings.
- Unblocked the publish-time TypeScript build by typing MCP cron serialization
  against normalized domain `CronJob` values. Embedded and TCP MCP backends now
  expose identical optional cron fields instead of leaking protocol `null`
  values from TCP operations. TCP creation now reads authoritative nested cron
  metadata and propagates broker validation errors instead of returning a
  fabricated success. Dedicated embedded and real-TCP functional contracts now
  cover invalid input, add/list/get metadata parity, delete and post-delete
  lookup behavior.
- Normalized persisted result lookup at the QueueManager boundary so a missing
  result is `undefined` while an explicitly completed `null` result remains
  `null`. Flow reads now preserve every falsy value and omit only genuinely
  missing IDs in both runtimes.
- Enforced lease ownership consistently for ACK, FAIL, result-bearing/bare
  batch ACK, and every active-state Job move. A present lock now requires its
  exact token in embedded and TCP mode; processor `Job.changeDelay()` and
  `Job.retry()` bind that delivery token implicitly despite their tokenless
  public signatures. Rejected single and batch operations leave job state,
  result, and ownership unchanged, while unlocked administrative transitions
  and expired-but-current completions retain their recovery semantics.
- Made every processor-owned transition retire exactly one local delivery
  generation. Successful `retry()`, `changeDelay()`, `moveToWait()`,
  `moveToDelayed()`, and `moveToWaitingChildren()` now suppress both the later
  automatic ACK and catch-path FAIL without synthesizing a terminal event or
  counter. A rejected token still follows normal failure handling.
  Synchronous `Job.discard()` registers one pending broker settlement before
  returning; graceful close waits for it, duplicate calls share it, an
  authoritative no-op is silent, and a real rejection emits one scoped Worker
  error. `Discard` now carries and verifies the current lease token in Embedded
  and TCP mode, preventing a stale processor from dead-lettering a newer
  delivery. Deterministic regressions cover return/throw, close, duplicates,
  no-op, rejection, and stale-token redelivery in both transports.
- Made Worker processing generation-aware. A stall redelivery to the same
  automatic or manual Worker now starts with a fresh broker token; stale
  handlers cannot publish outcomes or erase the current heartbeat, lock,
  cancellation, limiter, or concurrency tracking. Embedded heartbeats now
  renew the exact current token just like TCP, and processor outcome logic was
  split into a focused module to keep runtime components below 300 lines.
- Fixed manual Worker lease propagation in embedded and TCP modes.
  `getNextJob()` now exposes a clean `ManualJob` with first-class `name`, typed
  user `data`, and the broker token; `processJobManually(job)` reuses that
  tracked token when omitted, while stale job objects cannot claim a newer
  delivery generation.
- Made Worker pause/resume lifecycle ownership idempotent. Paused Workers keep
  the single lease-renewal and registration heartbeat needed by active and
  buffered deliveries; `resume()` no longer creates an orphaned interval, and
  `close()` now permits natural process exit after any number of pause/resume
  cycles in embedded and TCP modes.
- Unreferenced the protocol limiter's opportunistic cleanup interval. The
  singleton still bounds idle TCP/HTTP client state while a server is active,
  but handling the first command no longer leaves a stopped broker process
  alive solely for maintenance.
- Fixed both sides of workflow compensation recovery ownership. `recover()` on
  the same live Engine no longer waits for its own compensation handler and
  deadlocks the caller. After `Engine.close(true)`, a replacement Engine in the
  same process still waits for the exact in-flight unwind owner, reloads the
  authoritative SQLite row through its own store, and retries only when
  compensation remains owed. Deterministic embedded and real-TCP regressions
  cover the live-owner and force-close paths, and the minimized command-model
  seed is retained as replay evidence.
- Made the TCP concurrency sweep correctness-gated. It no longer disables lease
  renewal or stops when processor invocations merely reach the requested count;
  each sample now reconciles accepted and invoked IDs, duplicate deliveries,
  authoritative broker terminal counts and Worker errors before publishing
  throughput. Host, port, scale, cases, heartbeat and timeout are explicit
  inputs, and the module is import-safe for a real dynamic-port SQLite test.
  The integrity test now reads the actual assigned listener port and the runner
  rejects a missing or invalid endpoint, eliminating a false-green path that
  could target an unrelated local broker on `:6789`.
- Fixed client-side TCP frame corruption under high-concurrency backpressure.
  Every physical connection now preserves partial command writes in order,
  resumes them on `drain`, bounds the pending byte queue, and discards it on
  disconnect instead of writing later frames ahead of a missing tail. A real
  200-way TCP Worker regression reconciles 1,000 accepted jobs with 1,000
  authoritative completions and zero duplicate processor invocations.
- Rebuilt the BullMQ comparison runner as focused sub-300-line modules. Both
  products now keep lease renewal active, reconcile accepted and invoked job
  IDs, reject duplicate processor calls or Worker errors, and stop timing only
  after their broker reports every job completed with no nonterminal residue.
  The runner uses isolated endpoints/run IDs, bounded deadlines, deterministic
  cleanup, import-safe startup, and natural process shutdown.
- Hardened the remaining native TCP benchmark entry points. The comprehensive
  and push/bulk-delta runners now accept isolated `BENCH_HOST`/`BENCH_PORT`
  endpoints and explicitly select TCP mode; comprehensive and batch-notify
  processing reconcile accepted and invoked IDs plus authoritative broker
  terminal counts before a bounded deadline. The self-hosted runner now binds
  an operating-system-assigned port. Every Queue and Worker is closed from
  `finally`, servers are always stopped, entry points are import-safe and exit
  naturally, and all runner modules remain below the 300-line source limit.
  Batch-notify also raises its self-hosted completed-job retention to its
  100,000-job maximum scenario, so authoritative counts cannot be truncated by
  the production broker's 50,000-job default.
  Comprehensive resets its shared Embedded manager after each scale, including
  error paths, preventing earlier samples from consuming the completed-job
  retention window used by its 50,000-job sample.
  Its durable TCP processing deadline is now a validated `BENCH_TIMEOUT_MS`
  input with a printed 600-second default, allowing slower native SQLite hosts
  to finish without weakening accepted-ID or authoritative-state conservation.
  Push/bulk-delta now shuts down its shared Embedded manager from the entrypoint
  `finally`, allowing natural process exit after the final median and applying
  the same teardown when any Embedded or TCP sample fails.
- Published the [dated v2.8.56 native engineering report](https://github.com/egeominotti/bunqueue/blob/main/docs/benchmarks/native-engineering-2026-08-03.md)
  with the final Apple M1 Max campaign. Repeated Workflow samples passed
  persisted integrity at 211–251 workflows/s Embedded and 273–319 workflows/s
  TCP for the four single-engine scenarios; the tuned 12-instance curve
  completed at 758/618
  workflows/s after the host saturated at eight instances. Queue,
  batch-notify, TCP serde/sweep, comparison, fix-impact, dependency, event,
  stress, and million-job diagnostics were rerun after the final release gates
  with their exact topology and correctness boundaries. The report keeps the
  durable SQLite-versus-in-memory distinctions explicit and preserves the July
  Ryzen 9 campaign as the publication-grade capacity reference.
- Made expired-lock recovery linearizable. Every candidate is revalidated under
  the shard and processing write locks against the same processing object, the
  same lease object, and the current expiry before any recovery budget or state
  is consumed. Concurrent sweeps can no longer reclaim one generation twice,
  double-increment attempts/stalls, duplicate notifications, or leave a job in
  both the waiting heap and DLQ. Terminal expiry now emits the documented
  `stalled` event before `failed` in embedded and TCP modes.
- Unified public Job lifecycle metadata for direct and list queries. Embedded
  and TCP proxies, reflected properties, `toJSON()`, and `asJSON()` now read the
  same authoritative attempts, started-attempts, stall count, progress,
  processing timestamp, and terminal timestamp instead of resetting fields on
  selected TCP paths.

## Embedded/TCP parity

- Added authenticated QueueEvents streaming over the binary TCP protocol with
  queue filtering, bounded writes, explicit subscribe/unsubscribe commands,
  dedicated client connections, and automatic resubscription after broker
  reconnect. TCP Workers now receive the same queue-scoped `stalled` event as
  embedded Workers.
- Made `FlowProducer.getParentResult()` and `getParentResults()` authoritative
  over TCP while preserving synchronous embedded compatibility, and fixed
  `Queue.waitJobUntilFinished()` to return the exact result for both an
  already-completed remote job and an in-flight completion event.
- Added authoritative async Bunqueue façade methods for pause/resume, DLQ
  configuration/reads/retry/purge, and global rate-limit changes. Legacy
  synchronous snapshot and fire-and-forget forms retain their documented
  compatibility contract.

## Architecture

- Kept the QueueManager, Queue, Worker, SandboxedWorker, transport, persistence,
  scheduling, Flow, MCP, and server layers split into focused modules no larger
  than 300 lines. New repeat scheduling, telemetry journal, QueueEvents TCP
  subscriptions, persistence migrations, Job metadata, DLQ conversion, and
  Worker outcome/manual-processing responsibilities live in dedicated modules
  instead of expanding the public façades.
- Continued separating contracts from behavior through domain, application,
  client, transport, and Worker `types/` modules. The queue hot path retains its
  synchronous lock boundaries and the documented lock order while persistence,
  protocol conversion, and public-object reflection remain independently
  testable.
- Added explicit SQLite migrations and bounded legacy decoding for the protocol
  v3 job-name model, persisted repeat policy, and telemetry tables. Existing
  databases are upgraded in place without rewriting arbitrary user payloads.
- Made SQLite schema upgrades fail closed and retryable. Pending DDL, legacy
  backfills, and the final version record run in one synchronous transaction;
  only exact duplicate schema-object errors are accepted as idempotent. Any
  disk-full, I/O, corruption, syntax, or constraint failure rolls back without
  advancing the version. Migration 6 retains two explicit statement boundaries
  so an old database with only one cron dedup column repairs the missing column
  before the current version is recorded.

## External SDKs

- Upgraded the TypeScript, Python, PHP, Go, Rust, and Elixir SDKs to negotiate
  protocol v3 and advertise `separate-job-name`. All producers, bulk producers,
  schedulers, workers, Job objects, and flow snapshots keep the job name in its
  wire field and preserve arbitrary user data, with bounded legacy-envelope
  decoding for older brokers and rows.
- Extended the shared conformance runner with name/data round trips, mixed and
  scalar payloads, scheduler names, legacy decoding, and protocol capability
  checks. Each SDK also retains a native regression so conformance cannot pass
  through a driver-only adaptation.
- Forwarded Worker lease tokens through active Job mutations where required and
  preserved authoritative broker results in the language-specific Queue/Admin
  surfaces.
- Made late Worker outcomes broker-authoritative across all six SDKs. An exact
  timeout or retired-lease no-op no longer emits or counts a contradictory
  local terminal result; Rust settles the handler attempt without synthesizing
  terminal state. TypeScript and Python require positional `ignoredIndices`
  for ACK batches, remain correct with duplicate job IDs, and reject ambiguous
  or malformed evidence.

## Documentation and verification

- Converted all 37 Queue, Worker, Cron, DLQ, and Flow guide pages into 40
  real-broker executable files. The combined embedded/TCP guide audit now runs
  642 tests and 1,888 assertions with no expected-failure pins.
- Added a fail-closed, no-mock core E2E matrix that automatically discovers all
  308 callable Queue, Worker, Job, Cron, DLQ, Flow, Workflow, transport and
  related facade instance methods from TypeScript. It exercises the exact
  applicable surface against fresh embedded and real TCP SQLite runtimes. A
  dedicated required CI job now blocks the release graph when any public class
  or method is uncovered or fails its runtime contract.
- Expanded that gate into 580 applicable method/transport checks and a complete
  308-row Markdown/JSON evidence matrix uploaded by CI for direct review.
- Added shared embedded/TCP script contracts for real QueueEvents lifecycle
  payloads, Worker stall delivery, exact wait results, falsy/null Flow results,
  missing-result semantics, queue isolation and subscription teardown. Focused
  regressions also cover authentication, raw unsubscribe, command/event
  correlation, and reconnect/resubscribe.
- Added shared `skeptic` reviewer profiles for Claude Code and Codex CLI, with
  repository instructions requiring the review before every commit and push.
  Repository content is now English-only, and obsolete design plans plus a
  redundant manual Simple Mode script were removed.
- Added fresh disposable OrbStack Machine release gates on the Mac's native
  architecture. Ubuntu 24.04 is the canonical local Linux gate and Debian 13
  checks distribution compatibility, both without host mounts, credentials, or
  reusable state. GitHub Actions supplies independent native `amd64` coverage;
  translated Rosetta runs are diagnostic only.
- Fixed the cross-runtime documentation fixture teardown order so its embedded
  manager closes before the temporary SQLite directory is removed. The full
  guide run no longer carries a false WAL-checkpoint cleanup warning.
- Hardened the crash-recovery subprocess harness for parallel isolation by
  asking the kernel to assign its unused HTTP listener instead of assuming the
  port adjacent to TCP is free. The expired-lock regression now asserts the
  explicit broker-authoritative `already-finalized` result.
- Gave the publish-build regression a 40-second harness budget while keeping
  its 30-second build deadline, so a valid fresh Linux build is not terminated
  by Bun's unrelated five-second default test timeout.
- Added deterministic embedded and real-TCP regressions for terminal lock event
  order, overlapping expiry sweeps, attempts/stall conservation, queue/DLQ
  exclusivity, and public Job metadata reflection. These tests first failed on
  the old implementation and now run as ordinary required tests—no
  `test.failing` or expected-failure pins remain.
- Passed the final real TCP/SQLite command model with 10 generated histories and
  83,939 invariant assertions. The complete isolated product sandbox passed
  8,120 unit tests, 489 TCP integration checks, and 332 embedded integration
  checks with zero failures; the isolated SDK sandbox passed 611 tests across
  all six native suites and their shared conformance contracts, with only three
  declared long-running soak profiles excluded.
- Reviewed the sandbox's only telemetry signal, end-to-start RSS growth in the
  single process loading 582 unit files. Three fresh-process TCP/SQLite chaos
  soaks, each with continuous worker kills plus final compact/GC checks, passed
  without job loss, unbounded engine collections, WAL growth, or latency drift.
  TCP ended below its starting RSS; embedded ended only 26.3 MiB above its
  start and remained below the anomaly threshold with a 91.0 MiB peak.

---

[← bunqueue v2.8.55](/blog/bunqueue-v2-8-55/) · [Full changelog](/changelog/) · [All posts](/blog/)
