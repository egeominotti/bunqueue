---
title: "bunqueue v2.9.7"
description: "Fixes 9 bugs. PUSH, PUSHB, PUSHF and HTTP push validate backoff.maxDelay."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-9-7.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-10-02"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.9.7</em></h1>
  <p class="bq-hero-sub">Fixes 9 bugs. PUSH, PUSHB, PUSHF and HTTP push validate backoff.maxDelay.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.9.7

```bash title="bun"
bun add bunqueue@2.9.7
```

```bash title="npm"
npm install bunqueue@2.9.7
```

```bash title="docker"
TAG=2.9.7
docker run -p 6789:6789 -p 6790:6790 ghcr.io/egeominotti/bunqueue:$TAG
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Behavior changes

- **`PUSH`, `PUSHB`, `PUSHF` and HTTP push validate `backoff.maxDelay`.** A
  value that is not a finite number between 0 and 86,400,000 ms is now
  rejected; it used to be accepted and silently dropped. Go, PHP, Python and
  Rust pass the backoff object through unchanged, so their callers see the
  error too.
- **A `null` backoff is accepted.** `PUSH` with `backoff: null` used to fail
  with a raw engine error (`null is not an object (evaluating 'input.delay')`);
  it now uses the default backoff.
- **Elixir SDK: invalid `deduplication:` values raise `ArgumentError`.** A
  value without a non-empty string `id`, with unknown or repeated fields, that
  is not a map or keyword list (structs included), or combined with a raw
  `dedup` option used to be accepted and ignored.
- **A genuinely orphaned active job is retried instead of disappearing.** When
  stall detection is enabled for its queue, a job that sends no heartbeat,
  progress update or lock renewal for longer than both 30 minutes and its stall
  timeout (`stallTimeout`, or the queue's `stallInterval`), and holds no lease
  from its current delivery, is now recovered like a stalled job: retried with
  the attempt counted, or moved to the DLQ. It used to vanish from memory until
  a restart. Queues with stall detection disabled are left alone. Deliveries
  that keep sending heartbeats, or that hold an unexpired lease, never reach
  this path.
- **`DelayedError` delays are capped and never zero.** The delay is the base
  backoff (1 second when it is not positive) capped at a positive
  `backoff.maxDelay`, or at 1 hour otherwise. A `maxDelay` of 0 does not apply
  to `DelayedError`, so the postponement is never zero. A
  numeric backoff above 1 hour used to postpone the job for the full value. TCP
  workers now see `job.opts.backoff` in its object form when the job was added
  that way.
- **A disconnecting client only releases deliveries it still owns.** Each
  active job now records the connection and delivery that own it. Stall
  recovery, orphan recovery, lock expiration, timeouts, management moves and
  discards detach that ownership, so a client that went silent can no longer
  release the job's next delivery to another worker when it finally closes.
- **Python SDK: the pytest-based suites need Python 3.10 or later.** The test
  extra pins pytest 9.0.3, which drops Python 3.9; the SDK itself still
  supports 3.9.

## SDK releases

Every official SDK now has a release that speaks wire protocol v3, where job
names travel outside `data`. The packages published on 2026-07-20 (Python
0.1.5, PHP 0.1.1, Go v0.1.0, Rust 0.1.1) speak protocol v2: against a server
2.8.57 or later they lose the job name (`job.name` is empty), which breaks
name-based routing such as Python Simple Mode, and their flows are not atomic.
Upgrade every client together:

| SDK | Release | Notes |
|---|---|---|
| TypeScript `bunqueue-client` | 0.2.1 | Ships the engine fixes below for embedded mode; `BackoffOptions` accepts `maxDelay`. |
| Python `bunqueue-client` | 0.2.0 | Includes the never-published 0.1.6. |
| PHP `bunqueue/client` | 0.2.0 | Breaking: `Job::data()` returns `mixed`. |
| Go `sdk/go` | v0.2.0 | Breaking: `Job.Data()` returns `any`. |
| Rust `bunqueue-client` | 0.2.0 | Breaking: unsupported flow options are rejected. |

Each SDK changelog lists the full set of changes. The Elixir SDK is not on Hex
yet and is used from a checkout.

## Security

- **Documentation site dependencies upgraded.** Astro 7.3.5 (from 6.4.8),
  Starlight 0.42.5, `@astrojs/react` 7.0.0, `@astrojs/sitemap` 3.7.4 and sharp
  0.35.5 resolve the open advisories, including a critical remote code
  execution through AVIF image optimization in Astro, base-path authorization
  bypass and XSS issues in Astro, and libvips/libheif vulnerabilities in sharp.
  The site build does not process images through sharp, so those paths were not
  reachable, but the packages are patched.
- **Python SDK: pytest 9.0.3** for the vulnerable tmpdir handling in earlier
  versions.

## Bugfixes

- **Periodic cleanup no longer drops long-running jobs that are still alive.**
  The 10-second cleanup removed every active job started more than 30 minutes
  ago from memory without a state change, even while its worker kept sending
  heartbeats or renewing its lock, so the worker could no longer acknowledge
  it. A job now counts as orphaned only when nothing has been heard from it
  (no heartbeat, progress update or lock renewal) for 30 minutes and it holds
  no unexpired lock, and the check is repeated under the processing shard's
  write lock. PostgreSQL mode was not affected. Regression:
  `test/repro-cleanup-heartbeating-active-job.test.ts`.
- **`backoff.maxDelay` now caps retry delays.** The option was part of the job
  model and the retry calculation, and the Rust, Python and legacy TypeScript
  SDKs sent it, but job creation dropped it, so every job kept the 1-hour
  default cap. It is now kept and persisted, and `Queue.getJob`,
  `Queue.getJobs`, `FlowProducer` results and embedded `add()` return it in
  `job.opts.backoff`; jobs delivered to a TCP `Worker` still expose only the
  numeric base `backoff`, and the server applies the cap either way. Atomic
  flows reject an invalid value in both modes; embedded `Queue.add`/`addBulk`
  and scheduler job templates ignore it and keep the default. Regressions:
  `test/repro-backoff-max-delay.test.ts`, `test/backoff-max-delay-paths.test.ts`.
- **Elixir SDK: the `deduplication:` option works.** It was sent as `dedup`
  without a `uniqueKey`, which the server ignores, so two adds with the same
  deduplication id created two jobs. `deduplication.id` is now sent as
  `uniqueKey` and `ttl`, `extend` and `replace` as `dedup`, as in the other
  SDKs. An explicit non-empty `uniqueKey` still wins. Regression:
  `sdk/elixir/test/deduplication_options_test.exs`.
- **Orphan recovery releases what the job held.** When cleanup recovers an
  orphan it now goes through the stall path, which releases the queue
  concurrency slot, group slot and unique key, records the attempt in SQLite,
  and emits the `stalled` event and webhook. A lease left over from an earlier
  delivery no longer counts as liveness for the current one. Regressions:
  `test/repro-cleanup-orphan-recovery.test.ts`,
  `test/cleanup-orphan-recovery-guards.test.ts`.
- **Recovery sweeps act only on the current delivery.** The stall checker now
  re-checks that the job is still stalled after taking its locks, so a
  heartbeat or new delivery that lands meanwhile keeps the job. Lock expiration
  ignores a lease left from an earlier delivery instead of requeuing the newer
  one. Overlapping cleanup, stall and lock-expiration sweeps recover a job once.
  Regressions: `test/repro-recovered-job-stale-client-release.test.ts`,
  `test/repro-recovery-sweeps-current-generation.test.ts`,
  `test/repro-orphan-window-respects-stall-config.test.ts`.
- **`DelayedError` honors `backoff.maxDelay` in embedded and TCP mode.** The
  worker re-delayed the job by the base backoff and ignored the cap; TCP
  workers also dropped the backoff configuration the server sends.
  Regressions:
  `test/repro-delayed-error-max-delay.test.ts`,
  `test/repro-delayed-error-zero-max-delay.test.ts`.
- **Documentation:** the Rust SDK README listed APIs that do not exist
  (scheduler listing, webhooks, workers, stats, progress reads, children
  values), and the Rust and Elixir READMEs claimed `Hello` is sent on connect.
  The store-and-forward guides now state that a re-forward is deduplicated only
  while the remote job is live; completion or the DLQ releases its custom id.
- **CI: wider timing margins for a PostgreSQL deduplication test.** The
  extended-TTL convergence test left the extending push about 40 ms before a
  100 ms TTL expired and the contender about 110 ms, including the convergence
  wait, before the 180 ms extended TTL ended. Slow PostgreSQL 17 runners hit
  both cases and admitted a new job. The windows are now 1000 ms and 2200 ms,
  the contender is timed from the moment the first push returned instead of
  after the convergence wait, and the test still proves the extension outlives
  the original TTL. Regression:
  `test/postgres-dedup-cache-convergence.test.ts`.
- **CI: a Python SDK E2E test waits for the event it asserts.** The ACKB
  timeout-suppression test checked the worker's `completed` events as soon as
  the broker showed the job completed, but the worker emits the event only
  after the ACKB reply returns. A loaded Python 3.9 runner polled in between and
  failed. It now waits for the event and still asserts that only the live job
  completes. Test: `sdk/python/tests/e2e_worker_ack_batch.py`.

## Documentation

- **bunqueue Academy, the free video course, is on the site.** A new
  [`/academy/`](/academy/) page lists every episode with a player, a summary
  and the guide it follows, plus the episodes still in production; it is linked
  from the header and the sidebar. The homepage presents the course directly
  below the hero, with the 60-second overview, the released lessons and a "New"
  announcement in the hero.
- **Videos in the guides.** The introduction, quickstart, queue, worker, cron,
  dead letter queue and flow guides open with their Academy episode, and the
  dashboard guide and the homepage dashboard section show the dashboard's
  full tour. Players load YouTube (privacy-enhanced domain) only when you press
  play; until then the page serves a local thumbnail.
- **Homepage quickstart redesigned.** "Your first job, end to end." is now a
  segmented switch between the server and embedded paths, each in three
  numbered steps (start the server, connect your app and worker, see it work)
  with the expected output. Step 2 has a complete program for every official
  SDK: Node.js, Bun, Deno, Python, PHP, Go, Rust and Elixir.
- **The Go examples compile against the released SDK.** Every Go example on the
  site that indexes job data (homepage, quickstart, SDK guide, examples, use
  cases, cron and flow guides) now does it through
  `any(job.Data()).(map[string]any)`, which builds against `sdk/go` v0.1.0
  (`Data()` returns `map[string]any`) and v0.2.0 (`Data()` returns `any`). The
  type assertions used to fail with "is not an interface" for anyone who
  installed the released module.
- **README: bunqueue Academy.** A new section lists the released episodes with
  their length and guide, the header links the video course, and the dashboard
  section links its 8-minute tour.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.9.6](/blog/bunqueue-v2-9-6/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.9.7) · [Commits since v2.9.6](https://github.com/egeominotti/bunqueue/compare/v2.9.6...v2.9.7) · [Full changelog](/changelog/) · [All posts](/blog/)
