---
title: "bunqueue v2.9.18"
description: "Fixes 3 bugs. The weekly SDK advisory audit passes again for all six SDKs."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-9-18.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-10-23"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.9.18</em></h1>
  <p class="bq-hero-sub">Fixes 3 bugs. The weekly SDK advisory audit passes again for all six SDKs.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.9.18

```bash title="bun"
bun add bunqueue@2.9.18
```

```bash title="npm"
npm install bunqueue@2.9.18
```

```bash title="docker"
TAG=2.9.18
docker run -p 6789:6789 -p 6790:6790 ghcr.io/egeominotti/bunqueue:$TAG
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Security

- The weekly SDK advisory audit passes again for all six SDKs. It had failed
  every week since 16 August: until 4 October at the Go step, which skipped the
  Rust and Elixir audits, and on 11 and 18 October at the TypeScript step, which
  skipped the other five:
  - `oxfmt` pins its worker pool, `tinypool`, to 2.1.0, which has two critical
    advisories; the repository and the TypeScript SDK now override it to a
    patched release. It is a development dependency only and neither published
    package ships it.
  - The Go toolchain used by CI, the SDK workflows and the SDK test image moves
    from 1.26.5 to 1.26.10. The Go SDK's TLS connection reaches four standard
    library vulnerabilities fixed between 1.26.6 and 1.26.10 (GO-2026-6809,
    GO-2026-6607, GO-2026-6090, GO-2026-5972). The module still declares
    `go 1.26.5`; build applications with Go 1.26.10 or later on 1.26, or
    1.27.3 or later.
  - The Rust SDK's lockfile moves `rustls` to 0.23.46 and `rustls-webpki` to
    0.103.16 (RUSTSEC-2026-0285, -0346, -0348, -0349 and -0382); rustls 0.23.46
    also brings `aws-lc-rs` 1.18 and `aws-lc-sys` 0.46. The existing dependency
    ranges allow all of them, so applications only need
    `cargo update -p rustls -p rustls-webpki`.
- The root package's development dependencies no longer carry critical or high
  advisories: with the `tinypool` override above, `bun audit` drops from 48
  findings (3 critical, 19 high) to one low (`@ai-sdk/provider-utils` 2.x,
  pinned through the locked `@mastra/core` 1.53.0, which `bun audit fix`
  cannot move).
  The lockfile now resolves patched releases inside the existing version ranges
  (`bun audit fix`; `package.json` is unchanged): the MCP SDK used to develop
  and test `bunqueue-mcp` moves to 1.32.0, and `proxy-addr`,
  `brace-expansion`, `fast-uri`, `hono`, `@hono/node-server`, `js-yaml`,
  `markdown-it`, `nanoid` and `qs` move to their patched releases, as does
  `ip-address`, to 10.7.4, which also fixes GHSA-rxp7-6hxx-x8q5, published on
  22 October. The published package's dependencies were already clean
  (`bun audit --prod`), and its optional `@modelcontextprotocol/sdk` peer range
  is unchanged.

## Bugfixes

- With the PostgreSQL backend, a broker no longer briefly loses its own
  committed writes from its local view
  ([#158](https://github.com/egeominotti/bunqueue/issues/158)). A full-queue
  refresh that read PostgreSQL before the broker's own commit could finish after
  it, so a job the broker had just failed terminally could be reported `active`
  again and be missing from its DLQ until the job's event arrived; the same
  applied to its claims, completions, pushes, cancellations, DLQ removals and
  queue-wide operations. Each own commit is now recorded for such an in-flight
  refresh before the change is installed locally, so the refresh no longer
  overwrites it (see #161 below for how it is applied). Optimistic local settings
  that are applied before their deferred write commits (non-durable `pause`,
  `resume`, rate limit, concurrency, stall and DLQ configuration, `drain` and
  `obliterate`) can still be briefly reverted until the queue is reloaded. No data was lost, and claims were always decided in
  PostgreSQL.
- With the PostgreSQL backend, `WaitJob` (and so `waitUntilFinished` without
  QueueEvents) no longer returns the result of a completed job that `Cancel`
  has since removed ([#162](https://github.com/egeominotti/bunqueue/issues/162)).
  A broker receives a job's `completed` event after its commit, so the event of
  the ACK could arrive after the Cancel; a WaitJob reading the job at that
  moment answered with the event's result instead of `completed` without a
  result. It now takes the result from the job's completion record, which the
  Cancel cleared, as a waiting `WaitJob` already did. Memory and SQLite are
  unchanged. `test/postgres-cancel-outcome.test.ts` failed 8 of 50 runs under
  injected 0-15 ms scheduling delays before and 0 of 50 after.
- With the PostgreSQL backend, a full-queue refresh of a busy queue now applies
  on its first load ([#161](https://github.com/egeominotti/bunqueue/issues/161)).
  A refresh was discarded and reloaded whenever an event or the broker's own
  write for any job of its queue arrived while it loaded, so with steady traffic
  it could be retried indefinitely without applying. Meanwhile the broker's
  local view missed queue-level changes made through other brokers (pause, rate
  and concurrency limits, drain, clean, obliterate, DLQ pruning) and the
  recovery after a startup event-buffer overflow, and the broker's own
  queue-wide durable operations, such as `drainDurable` or a durable pause, could
  be missing from its view when they returned. A refresh now reads the journal
  position of its PostgreSQL snapshot and installs every job that did not
  change after it, leaving the jobs changed meanwhile to their own per-job
  refreshes, and an older refresh never replaces a newer one. Per-job state
  still converged, and claims were always decided in PostgreSQL. This also
  fixes the intermittent PostgreSQL test failure in which a broker still
  reported a queue as not paused right after another broker paused it during a
  burst of 256 pushes, and an ID-only update of a job the broker had not seen
  yet can no longer be briefly undone by an older refresh.

## Testing

- Two PostgreSQL event catch-up regressions no longer fail intermittently. They
  treated "event cursor at the journal head" as "snapshot updated", which stopped
  being true when job events became asynchronous projection refreshes; they now
  also wait for queued refreshes to settle and for the expected DLQ. Under
  injected 0-15 ms scheduling delays the old wait failed 14 of 200 runs and the
  new one 0 of 200. The PostgreSQL design notes now describe the asynchronous
  refresh instead of a direct snapshot update.
- The TypeScript SDK's cooperative-cancel end-to-end test no longer times out
  intermittently. The broker counts a job active before the worker has read its
  pull reply, and `cancelAllJobs` only cancels jobs the worker already holds, so
  the test could cancel one job instead of two; it now also waits until both
  processors have started. With a 5 ms stall after each count request the old
  test failed 31 of 50 runs and the new one 0 of 50.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.9.17](/blog/bunqueue-v2-9-17/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.9.18) · [Commits since v2.9.17](https://github.com/egeominotti/bunqueue/compare/v2.9.17...v2.9.18) · [Full changelog](/changelog/) · [All posts](/blog/)
