---
title: "bunqueue v2.9.14"
description: "Fixes 10 bugs. waitUntilFinished returned undefined, or Job <id> not found, for a job added with removeOnComplete: true (#155)."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-9-14.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-10-14"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.9.14</em></h1>
  <p class="bq-hero-sub">Fixes 10 bugs. waitUntilFinished returned undefined, or Job &lt;id&gt; not found, for a job added with removeOnComplete: true (#155).</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.9.14

```bash title="bun"
bun add bunqueue@2.9.14
```

```bash title="npm"
npm install bunqueue@2.9.14
```

```bash title="docker"
TAG=2.9.14
docker run -p 6789:6789 -p 6790:6790 ghcr.io/egeominotti/bunqueue:$TAG
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Upgrade notes

- **Results of jobs removed on completion stay in memory for up to 60 s.**
  `WaitJob` on such a job answers `{ ok: true, completed: true, result }`
  where it answered `Job not found`, so every SDK's wait helper returns the
  result. The cap counts jobs, not bytes: with the default 1,000 jobs, results
  of 256 KB hold about 256 MB more heap than 2.9.13. Configure it with
  `BUNQUEUE_REMOVED_RESULT_RETENTION_MS` and `BUNQUEUE_MAX_REMOVED_RESULTS`,
  `--removed-result-retention-ms` and `--max-removed-results`, or
  `storage.removedResultRetentionMs` and `storage.maxRemovedResults`; `0` in
  either turns it off and restores the 2.9.13 footprint. Embedded mode reads
  the same two environment variables, and a value the server would refuse
  (`5s`, `1e12`) makes the first embedded `Queue` or `Worker` throw the same
  error. `GetResult` is unchanged and still finds nothing for these jobs.
- **`Cancel` removes completed jobs** for every client: `job.remove()`,
  `queue.removeAsync()`, the fire-and-forget `queue.remove()`,
  `DELETE /jobs/:id`, `bunqueue job cancel`, the MCP `cancel_job` tool, the
  dashboard `job:cancel` command and the Python, Go, PHP, Rust, Elixir and
  TypeScript SDKs. Before, a completed job answered `ok: false` and stayed.
  Active and failed jobs are still never removed.
- **`Cancel` names the state that refused it.** A missing job still gets
  `Job not found or cannot be cancelled`; an existing job it does not remove
  now gets `Job cannot be cancelled: not in queue (current state: active)`
  (or `failed`, or `waiting` for a PostgreSQL job that another live job
  depends on), without "not found". The Go `Queue.Remove` and the PHP
  `QueueControl::remove`, which returned `false` for any "not found" reply,
  now return an error for those jobs and still return `false` for a missing
  one; the Elixir `CommandError.not_found?/1` is false for them. An MCP server
  of 2.9.13 still reports them as `success: false`. When the job moves into a
  removable state between the refusal and the state read (an active job that
  completes), Cancel tries again, at most three times in all; it targets the
  ID, so a job re-added under the same custom ID meanwhile can be the one
  removed, as with a Cancel sent a moment later.
- **`removeAsync()` and `job.remove()` reject for an existing job that was not
  removed**: an active or failed job (the `remove()` of a DLQ job included),
  and on PostgreSQL a waiting job that another live job depends on. A
  processor that awaits `job.remove()` on its own job without catching the
  rejection now fails that attempt: the job is retried and, once its attempts
  are used up, moves to the DLQ, where 2.9.13 completed it after one run. A
  TCP FlowProducer job's `remove()` on a missing job now resolves, as every
  other `job.remove()` does, instead of rejecting. Against a 2.9.13 broker,
  whose refusal is ambiguous, the client reads the job's state and applies
  the same rule.
- **A concurrency limit set while jobs run admits nothing new** until fewer
  jobs than the limit are active. 2.9.13 admitted new jobs at once and could
  run above the limit.
- **`retryCompleted()` resets the stall count**, so a retried job gets its
  full `maxStalls` budget again.
- **PostgreSQL:** after a completed job is removed, `WaitJob` on its ID
  answers `completed: true` with no result, because the completion record
  stays without the result; memory and SQLite answer `Job not found`.

## Bugfixes

- **`waitUntilFinished` returned `undefined`, or `Job <id> not found`, for a
  job added with `removeOnComplete: true`**
  ([#155](https://github.com/egeominotti/bunqueue/issues/155)). Over TCP
  without `QueueEvents` the wait holds `WaitJob` on the broker. A hold that saw
  the completion re-read the result from the completed-job store, where such
  a job keeps nothing, and answered `completed: true` with no result; a wait
  that reached the broker after the completion, with or without `QueueEvents`,
  rejected with `Job <id> not found`. In the issue's request/reply script about
  half of the waits got `undefined` and the other half `not found`. A hold now
  answers with the result carried by the `completed` event that wakes it, and
  memory and SQLite brokers keep the result of a job removed on completion in
  a short-lived, memory-only record (60 s, at most 1,000 jobs) that the
  broker's completion lookup reads, so a wait that arrives within 60 s gets
  its result (unless more than 1,000 such jobs completed since). The record
  is never written to disk, and a new job under the same ID, `remove()`,
  obliterating the queue, a shutdown or a restart drop it. PostgreSQL already
  kept a completion record with the result and is unchanged.
- **`job.remove()` on a completed job answered ok and removed nothing**
  ([#155](https://github.com/egeominotti/bunqueue/issues/155)). The broker's
  `Cancel` removed only pending jobs, and the client ignored its refusal, so
  the job kept its data and result until retention while the caller believed
  it was gone. `Cancel` now also removes a completed job: one SQLite
  transaction (one PostgreSQL transaction, which also deletes its logs)
  deletes its row and its result, then its in-memory projections and logs go.
  It keeps only the payload-free completion record that `removeOnComplete`
  keeps, so a job that depends on it still runs. As for a `removeOnComplete`
  child, a flow parent that has not run yet still reads the removed child's
  value from memory until a broker restart on SQLite; PostgreSQL drops it with
  the result. The bounded event journals (`queue_events`, `bunqueue_events`)
  keep the events already recorded, such as the `completed` event with the
  return value, until their retention trims them; the PostgreSQL `removed`
  event carries no job data. `removeAsync()` and every `job.remove()`,
  FlowProducer jobs included, now reject when the job exists but was not
  removed, and still resolve when the job does not exist.
- **`WaitJob` could miss a completion during its initial asynchronous job
  read**, before its completion waiter was registered
  ([#155](https://github.com/egeominotti/bunqueue/issues/155)). The wait now
  captures the matching completion event before the first read and passes
  its result to the caller, including when removed-result retention is
  disabled. It registers the normal waiter before releasing that temporary
  subscription, and every return or error releases its subscriptions and timers.
- **`WaitJob` and `GetResult` lost completed SQLite results after the
  completed-job cache evicted the job**, even though the completed row and
  result remained on disk. Completion queries now read SQLite's current
  state after a cache miss, including after a broker restart and for valid
  `undefined` results. A cached result alone never proves completion, and a
  waiting, active or failed generation under the same ID suppresses stale results.
- **`WaitJob` could report a new waiting custom-ID generation as completed
  with an `undefined` result.** An asynchronous job read could return a
  completed snapshot after another request reused its ID. The handler now
  confirms completion against the current generation and waits for the new
  job instead of trusting the old snapshot.
- **A queue concurrency limit ignored the jobs already running when it was
  set.** `setConcurrency(2)` with one active job let two more start (three
  active), a job that was active before the limit freed a slot it never held
  when it finished, and clearing then setting the limit forgot the running
  jobs. Each job now holds its own slot, and a new limit counts the jobs
  already active. PostgreSQL already counted them.
- **A late ACK of a retried job freed a group concurrency slot it did not
  hold.** A job that failed and was scheduled for a retry, then acknowledged
  by its first worker, released its group's slot while another job of the
  group ran, so a group with concurrency 1 admitted a second job. Group slots
  are now owned per job, like queue slots: a release by a job that holds no
  slot does nothing. PostgreSQL never had this bug.
- **Above 100,000 indexed jobs, the cleanup sweep could lose a job whose ACK
  was in flight.** The orphaned-index sweep deleted the `processing` entry of
  a job between the two steps of its ACK: the ACK failed with `Job not found`,
  the job read as `unknown` until a restart, and its queue concurrency slot
  stayed taken. An entry is now removed only when a second sweep, at least
  60 s later, still finds it orphaned.
- **`retryCompleted()` kept the stall count** of a job that stalled before it
  completed, so its next run reached `maxStalls` early. It now resets it to 0,
  as a DLQ retry and the PostgreSQL engine do.
- **Startup recovery rewrote a recovered flow parent's SQLite row from
  `waiting` to `delayed`.** The job's reported state was already right; the
  stored row now matches it.

## Testing

- **Issue #155 request/reply regressions** exercise real Queue and Worker
  instances in embedded and TCP modes, including object, `null`, `false`,
  `0` and `undefined` results, payload and result deletion, explicit removal
  of retained results, and removal durability across a broker restart.
  Deterministic tests also cover completion-registration races, reused IDs,
  cold SQLite completions and waiter cleanup on failures.
- **Model campaigns.** `BUNQUEUE_MODEL_SIZE` and `BUNQUEUE_MODEL_PATH` replay
  one generated history exactly; the command cap is the real bound only with
  `BUNQUEUE_MODEL_SIZE=max` (at the default size a history has at most 10
  commands). A second campaign, weighted toward completing jobs, now
  exercises completion, failure, retry and cancel histories on every run;
  before, cancelling a completed job ran 0 times by default. The model now
  expects a completed retry to clear the progress message, as the engine and
  its documentation specify.
- **Crash recovery test.** `CR6` closed the client before the `SIGKILL`, so
  the broker sometimes returned the leased job to the queue first and the
  test saw 0 attempts (4 failures in 100 Linux runs). It now kills the broker
  first and waits for the job's `active` row on disk instead of sleeping.
- **SDK sandbox.** The Elixir test helper left six test brokers running after
  every `mix test` (about 55 MiB each); it now stops them when their owner
  exits. SDK suites now measure retained memory and surviving processes
  between two idle checkpoints around each suite command, so the growth
  signal no longer compares samples from different build and test steps.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.9.13](/blog/bunqueue-v2-9-13/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.9.14) · [Commits since v2.9.13](https://github.com/egeominotti/bunqueue/compare/v2.9.13...v2.9.14) · [Full changelog](/changelog/) · [All posts](/blog/)
