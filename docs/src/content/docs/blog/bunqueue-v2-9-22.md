---
title: "bunqueue v2.9.22"
description: "SIGHUP now reloads a renewed TLS certificate without a restart and without touching open connections. TCP processing on SQLite is 1.93x faster when workers return results, with one commit per batch instead of two per job. And a flow parent no longer waits forever when a crash, a lock expiry or a stall uses up a child, or when a nested parent fails; parents that older versions left waiting are repaired at startup."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-9-22.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-11-13"
---

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.9.22</em></h1>
  <p class="bq-hero-sub">SIGHUP now reloads a renewed TLS certificate without a restart and without touching open connections. TCP processing on SQLite is 1.93x faster when workers return results, with one commit per batch instead of two per job. And a flow parent no longer waits forever when a crash, a lock expiry or a stall uses up a child, or when a nested parent fails; parents that older versions left waiting are repaired at startup.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

Certificates get renewed. A queue broker should stay up while that happens, but
until now bunqueue made you choose. A TLS server read its certificate and key
once, when it bound its listeners, so it served a renewed certificate only after
a restart. And `SIGHUP` was not handled at all. Its default action killed the
process (exit 129) without the graceful drain that `SIGTERM` gets, and every
client was dropped.

v2.9.22 turns `SIGHUP` into a certificate reload
([#189](https://github.com/egeominotti/bunqueue/issues/189)). New handshakes get
the new certificate. Connections that are already open keep the one they were
opened with.

The release also makes finishing a job cheaper and closes a family of flow bugs.
When a TCP worker returns results, the SQLite broker now commits once per batch
instead of twice per job. In the benchmark taken on that change, processing went
from 6,825–6,892 to 13,176–13,266 jobs/s. A flow parent can also no longer be
left in
`waiting-children` forever by a child that a crash, an expired lock or a stall
used up, or by a nested parent that `failParentOnFailure` failed. Parents that
older versions stranded this way are repaired at the next startup.

#### To install bunqueue v2.9.22

```bash title="bun"
bun add bunqueue@2.9.22
```

```bash title="npm"
npm install bunqueue@2.9.22
```

```bash title="docker"
TAG=2.9.22
docker run -p 6789:6789 -p 6790:6790 ghcr.io/egeominotti/bunqueue:$TAG
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## A renewed TLS certificate is served without a restart

With TLS configured, `SIGHUP` re-reads `TLS_CERT_FILE` and `TLS_KEY_FILE`,
checks that the pair is valid and moves both listeners to it. Replace the files
at the paths the server started with, then send the signal:

```bash
# 1. Replace both files (write a sibling, then rename it over the live path)
cp renewed/fullchain.pem /etc/bunqueue/cert.pem.new && mv /etc/bunqueue/cert.pem.new /etc/bunqueue/cert.pem
cp renewed/privkey.pem /etc/bunqueue/key.pem.new && mv /etc/bunqueue/key.pem.new /etc/bunqueue/key.pem

# 2. Tell bunqueue to reload them
kill -HUP <pid>
```

New handshakes on the TCP and the HTTP port (`https://`, `wss://`, SSE) get the
new certificate. Open connections stay on their socket, WebSockets and SSE
streams included. They keep the certificate they were opened with:

| Situation | v2.9.21 | v2.9.22 |
| --- | --- | --- |
| A renewed certificate on disk | Served only after a restart | Served to new handshakes after `SIGHUP` |
| `SIGHUP` to a TLS server | Default action: the process exits (129) without a graceful drain, dropping every client; ignored under `nohup` | Reloads the certificate; the process keeps running |
| Open connections, WebSockets, SSE streams | Lost with the process | Stay on the certificate they were opened with |
| A pair that cannot be loaded (cert/key mismatch, missing or unreadable file, not PEM) | No reload | Refused before any listener changes; every port keeps the previous certificate |
| `SIGHUP` to a server without TLS | Default action; ignored under `nohup` | Unchanged: no handler is installed |

### Every reload logs one outcome, and only what is true

| Log line | What it means |
| --- | --- |
| `TLS certificate reloaded` | Both listeners serve the new pair. The line carries the new certificate's subject, expiry (`notAfter`) and SHA-256 fingerprint |
| `TLS reload failed; still serving the previous certificate` | The pair was refused, or a listener could not take it and the others rolled back. Every port keeps the previous certificate, and the line gives the reason |
| `TLS reload failed and left a listener degraded; restart the server` | A rollback itself failed. Restart the server |
| `SIGHUP ignored: the server is shutting down` | A `SIGHUP` during a shutdown never rebinds a listener |
| `SIGHUP ignored: the server is still starting` | A `SIGHUP` handled before the reload is wired, in practice only while a failed bind is shutting startup down. Nothing changes |

### How a listener changes certificates

Bun ignores `reload({ tls })` on both `Bun.listen` and `Bun.serve`, so a
listener cannot change its certificate in place. Each one is replaced instead.
A new listener binds the same port with SO_REUSEPORT and the new pair, then the
old one stops accepting without closing the connections it already accepted.

The HTTP unix socket cannot be shared between two listeners, so it is rebound in
place. If the new bind fails, it rebinds the previous pair. The new socket file
gets back the old one's mode, so a `chmod 660` made after startup survives. It
also gets back the owner and group when the server's user may set them; an owner
or group the process may not set is kept as created and logged.

The reload is synchronous and all-or-nothing. A pair that cannot be loaded is
refused before any listener changes. If one listener cannot take the new pair,
the others roll back, and every port keeps the previous certificate. Changing
the cert or key *path* still needs a restart, because a reload re-reads the paths
from startup.

### Reloading in Docker without losing the restart policy

The images still declare no stop signal, so Docker counts `docker kill -s HUP`
as a manual stop. The certificate is reloaded and the container keeps running,
but the restart policy no longer restarts it after its next exit. To keep the
policy, send the signal from inside the container:

```bash
docker exec <container> kill -HUP 1            # alpine
docker exec <container> sh -c 'kill -HUP 1'    # debian and slim
```

Or opt in to a declared stop signal. On distroless, which has no shell and no
`kill`, this is the only way:

```bash
docker run --stop-signal SIGTERM ...
```

```yaml
# docker-compose.yml
services:
  bunqueue:
    stop_signal: SIGTERM
```

The setting changes every other signal too. For that container,
`docker kill -s <signal>` with any signal other than `SIGTERM` and `SIGKILL` no
longer counts as a manual stop. The new
[Renewing certificates](/guide/tls/#renewing-certificates)
section of the TLS guide covers both ways, plus systemd and what to put in a
renewal hook.

### Before you upgrade

- **`SIGHUP` no longer stops a TLS server.** A TLS server started in an
  interactive terminal keeps running when that terminal closes. Stop it with
  `SIGTERM` or `SIGINT`, or run it under a supervisor. Under `nohup`, where
  `SIGHUP` used to be ignored, a TLS server now reloads its certificate on it,
  for example on an SSH logout or a logrotate `kill -HUP`. A TLS server claims
  `SIGHUP` before its listeners bind, so a `SIGHUP` handled before the reload
  is wired (in practice only while a failed bind is shutting startup down) logs
  `SIGHUP ignored: the server is still starting` instead. A server without TLS
  is unchanged.
- **TLS listeners set SO_REUSEPORT,** so that a reload can bind the replacement
  on the same port. A TLS listener on an IP port first makes a plain exclusive
  probe bind on that port. A port that something already holds still fails
  startup with the same address-in-use error, so a second broker cannot share
  it. Plain listeners bind exactly as before.
- **On Linux, a connection that races a reload can be reset.** While both
  listeners are bound, the kernel spreads new TCP handshakes across them. A
  handshake that completed in the old listener's accept queue, but was not
  accepted before that listener closed, is reset. The client reconnects (the
  bunqueue SDKs do so on their own). Established connections are never
  affected.
- **Unreadable files fail with a clearer error.** TLS startup now reads the cert
  and key files into memory before binding. A missing file fails with the same
  `TLS cert file not found` / `TLS key file not found` error. An unreadable one
  (for example a permission error) fails startup with the file-system error
  that names the path.

## One commit per batch: workers that return results run 1.93x faster on SQLite

When a TCP `Worker`'s processor returns a value, the worker acknowledges its
jobs with a batch `ACKB` that carries the results. Until now, the broker turned
each job in that batch into two SQLite autocommits: one for `storeResult` and
one for `markCompleted`. During processing, those two commits per job took
about 60% of the broker's CPU.

v2.9.22 runs the same two statements, with the same arguments and in the same
order, inside one SQLite transaction per batch. The throughput figures were
measured on the change itself, commit `cf21d8bf`, before and after it; they were
not measured again on the final 2.9.22 tree:

| Measure | Before `cf21d8bf` | With `cf21d8bf` |
| --- | --- | --- |
| SQLite commits for a batch `ACKB` with results | 2 per job | 1 per batch |
| TCP processing, 50,000 jobs | 6,825–6,892 jobs/s | 13,176–13,266 jobs/s (1.93x) |

Push and bulk push throughput did not change in the same measurement.

### Same outcomes, fewer commits

Batching commits is only safe if every job ends exactly as it did before, so the
batch keeps the per-job semantics. It stops at the first failure, exactly where
the per-job loop stopped. It commits the writes that succeeded and replays each
outcome through the same disk-full bookkeeping. Every outcome is unchanged,
including the 2.9.11 fault matrix and the lock-contention behavior. Two cases
keep the per-job writes: a job that is still in the write buffer, and a failed
`BEGIN` or `COMMIT`.

## A failed child no longer strands its flow parent

A flow child can carry a failure policy that decides what happens to its parent
when the child fails terminally: `failParentOnFailure`,
`ignoreDependencyOnFailure`, `removeDependencyOnFailure` or
`continueParentOnFailure`. Two gaps let a parent sit in `waiting-children`
forever instead.

### Children used up by a crash, an expired lock or a stall

A child can use up its attempts (or `maxStalls`) outside a worker FAIL, in three
places: startup recovery after a broker crash ("Job reached max attempts (N)
during startup recovery"), lock expiry ("Lock expired at max attempts (N)") and
stall detection. Such a child went to the DLQ, but its policy never ran. No `flow_failures` record was written, and the parent kept
waiting. A production-style FlowProducer campaign found it: 50,100 jobs with
broker SIGKILLs left 21 parents in `waiting-children`.

These paths now apply the policy the way a terminal worker FAIL does. The outbox
record commits in the same SQLite transaction as the DLQ move, so a crash right
after the move cannot lose the policy. The parent is failed, promoted or
detached in memory (or by the startup outbox replay), with the same child
`flow:failed` dashboard event. Retry, backoff, stall counting, DLQ reasons and
messages are unchanged. PostgreSQL mode was not affected: its lease expiry
already applied the policy in the same transaction.

### `failParentOnFailure` now climbs the whole tree

A parent that `failParentOnFailure` moves to `failed` has failed terminally
itself, but its own policy toward its parent never ran. Take a three-level flow:

```ts
await flow.add({
  name: 'grandparent',
  queueName: 'reports',
  data: {},
  children: [
    {
      name: 'mid',
      queueName: 'reports',
      data: {},
      opts: { failParentOnFailure: true },
      children: [
        { name: 'leaf', queueName: 'reports', data: {}, opts: { failParentOnFailure: true } },
      ],
    },
  ],
});
```

When `leaf` fails terminally:

| Version | `mid` | `grandparent` |
| --- | --- | --- |
| v2.9.21 | `failed` (`Child job <id> failed: …`) | `waiting-children`, forever |
| v2.9.22 | `failed` | `failed`: `mid`'s own policy applies |

`grandparent` also stayed stuck when `mid` carried any of the other three
policies. Now the failed parent's own policy applies to its parent, level by
level up the tree, as BullMQ does. Each level's `flow_failures` record commits
in the same SQLite transaction as that parent's DLQ move. The effect runs after
the shard lock is released, and the startup outbox replay propagates the same
way. A crash between "mid failed" and "grandparent updated" therefore cannot
strand the grandparent. A failed parent without a policy or without a parent
keeps exactly the previous writes and events. Siblings are not cancelled, the
parent's attempts are not consumed, and DLQ reasons and messages are unchanged.

PostgreSQL propagates the same way. Each next level runs in its own transaction
after the commit, with the locks of a terminal child failure, so the lock order
stays deadlock-free. Brokers serialize on the failed parent's
dependency-completion lock, so each level applies exactly once. The recovery
sweep of any broker, at startup and on every lease-recovery tick, finishes a
chain that a crash interrupted between two levels. During a rolling upgrade,
older brokers stop a chain at one level, and a mid-level parent they fail
writes no record. The startup repair below writes it on the next start of a
newer broker.

## Parents stranded by older versions are repaired at startup

Fixing the bugs stops new parents from getting stuck. It does not release the
parents that are already stuck, so startup now looks for them. The target is a
parent in `waiting-children` with a dependency edge on a child that has a
failure policy and failed terminally (it is in the DLQ), with no `flow_failures`
outbox record.

For each one, startup writes the missing record in the shape a terminal failure
writes, with the DLQ entry's error and the time of the child's last failed
attempt. The existing outbox replay then applies it. The parent is failed,
released (with the entry in `getIgnoredChildrenFailures()`) or promoted (with
the entry in `getFailedChildrenValues()`), and a repaired `fail` keeps climbing
the tree.

The repair is idempotent: an applied record removes the edge or fails the
parent, and an existing record is never replaced. It is also conservative. It
never touches:

- a child without a policy (the parent keeps waiting, the documented default);
- a child that is still retrying or queued;
- a discarded or quarantined child (DLQ reason `unknown` without a "Child job"
  error), because those paths never applied a policy;
- a parent that was running when the child failed, because no version applies a
  policy to a running parent;
- a parent that someone acted on after the failure: any timeline transition at
  or after the failure other than `waiting-children` (a DLQ retry, a run, a
  promotion), or a `lastHeartbeat` at or after it.

### What the repair costs

On SQLite the scan runs once, in memory, over the recovered waiting parents,
before the outbox replay. The log names the first 20 repaired pairs and gives
their count. A write error stops startup, as the replay's own writes do.

On PostgreSQL, every broker process makes one full pass over
`bunqueue_dependencies` in primary-key order. It reads one slice of at most
1,000 edges at startup, then one slice 250 ms after the previous one finished,
until the last edge. A slice holds one pool connection while it runs, and slices
never overlap. Every match is re-checked under the locks of a terminal failure
of that child and written with `ON CONFLICT DO NOTHING`, so it applies exactly
once across brokers. The pacing sets a ceiling:

| Case | Behavior |
| --- | --- |
| Throughput | At most about 4,000 edges/s per broker |
| 100,000 edges | At least about 25 s |
| Ten brokers restarting on 1,000,000 edges | At least about 4 minutes of reads each, since every broker makes its own pass |
| After a clean pass | The broker stops scanning; no repair timer stays armed |
| After a pass with errors | A new pass after 60 s, doubling after each further failed pass, up to one hour |

Until a pass completes cleanly, its error stays in the
`maintenance:flow-failure-repair` health entry. A candidate row that cannot be
decoded fails only its own edge instead of stalling the pass. A parent that an
older broker strands later in a rolling upgrade is repaired by the startup pass
of the newer broker that replaces it. There is no schema change. A child removed
on failure (`removeOnFail`) or purged from the DLQ leaves no trace to repair
from.

### What changes for flows when you upgrade

- **The first start repairs stranded parents.** Parents that an older version
  left waiting on a terminally failed child with a policy are failed, released
  or promoted at startup. A promoted parent runs at once, and a released one
  when its other dependencies are done, possibly long after its child failed.
  On SQLite the log names the first 20 repaired pairs and their count.
- **PostgreSQL: every broker start makes its own repair pass.** Each start
  reads all of `bunqueue_dependencies`, paced as in the table above, and holds
  one pool connection per slice. At 1,000,000 edges that is at least about 4
  minutes of reads per broker. The first slice (at most 1,000 edges) runs
  before the broker is ready. Errors stay in the
  `maintenance:flow-failure-repair` health entry until a pass completes
  cleanly. Like any stored PostgreSQL runtime error, they mark HTTP
  health/readiness degraded and set `bunqueue_storage_degraded=1`. Readiness
  no longer waits on an unbounded flow-failure recovery sweep: each sweep run
  reads at most 10 pages of 100 records.
- **Policies apply on every terminal failure.** A child used up by startup
  recovery, lock expiry or stall detection now applies its policy and emits the
  child `flow:failed` dashboard event (PostgreSQL already did this).
  `failParentOnFailure` now climbs the whole tree, as in BullMQ, and a failed
  parent that carries a policy also emits the child-level `flow:failed` event
  toward its own parent. On PostgreSQL, a pending `ignore`/`continue` record is
  reported by `getIgnoredChildrenFailures()` / `getFailedChildrenValues()` only
  once it is applied.
- **One failure event per parent.** A parent failed by several siblings at once
  emits `failed` and the parent-level `flow:failed` once, with the winning
  child's reason, instead of once per sibling.
- **PostgreSQL rolling upgrades.** Older brokers still stop a chain at one
  level and write no record for a mid-level parent they fail, and their reads
  can briefly report a pending `ignore`/`continue` record. The startup pass of
  the next newer broker to start repairs what they leave behind.

## Type-checking the test suite caught 31 genuine test defects

The root project and the TypeScript SDK now type-check and format with Bun's
own tools: `bun check` (`bun run typecheck`) and `bun fmt` (`bun run format`,
`bun run format:check`), configured in the `[fmt]` section of `bunfig.toml`.
`oxlint`, `oxfmt` and `oxlint-tsgolint` are gone from both, and linting is
dropped.

The bigger change is that `bun run typecheck` now checks the test tree too.
There were 1,039 type errors in `test/` and in the `bench/`/`scripts/` helpers
the tests import. Type-only changes fixed 1,008 of them. Of the 288 files those
changes touched, 233 transpile to identical JavaScript. Another 8 differ only in
whitespace, and 47 only by dropped unused bindings (each call kept), renamed
unused parameters and similar edits. No test does or asserts anything
different.

The remaining 31 errors, in 15 files, were genuine test defects that only a
behavior change could fix. Some examples:

- **Options the engine silently ignored.** With `attempts` fixed to
  `maxAttempts`, the stale ack timeout repro now really runs with 2 attempts.
  `jobId` instead of `customId` made the CLI read invariants read "not found";
  they now read real jobs. `maxRetries` became `maxAutoRetries`.
- **Filters passed the wrong way.** `getJobs([...])` became
  `getJobs({ state: [...] })`, so the restart and dedup-recovery checks now
  filter by state.
- **A flood too small to evict.** The issue 34 floods used 5,100 jobs against a
  10,000-entry result cache, so nothing was evicted. They now exceed the real
  `maxJobResults` and run on SQLite, and the parent-result test fails if an
  evicted result is not read back from storage.

One defect was in a public type. `Job.updateProgress` and its handler types now
accept `number | object`, as the runtime and the docs already did, and the
emitted JavaScript is unchanged:

```ts
await job.updateProgress(50);
await job.updateProgress({ stage: 'upload' }); // now type-checks
```

The Worker `progress` listener keeps its `number` parameter, so existing
`(job, p: number) => …` listeners still compile. The standalone TypeScript SDK's
legacy `Job.updateProgress` accepts the same types. No test file is excluded
from type checking, and `test/tsconfig-test-exclusions.test.ts` fails if one
ever is, or if the compiler options are weakened.

## Other improvements

- **An agent harness for coding agents.** `CLAUDE.md` (39 KB) and `AGENTS.md`
  (17.5 KB) are now routing pages of under 12 KiB each. They keep every
  mandatory rule and gate, and their reference sections moved verbatim to
  `docs/agents/`. New root files track work items, progress and handoffs.
  `init.sh` is a startup check (about 5 s once dependencies are installed), and
  contract tests enforce the layout. The structural score from
  `validate-harness.mjs` (of the learn-harness-engineering course the harness
  follows) went from 32/100 to 100/100. Nothing in the package or the runtime
  changes.
- **`bun fmt` covers tests, scripts, benchmarks and examples.** It now also
  formats `test/`, `scripts/`, `bench/`, `examples/` and `sdk/conformance` (227
  files reformatted, layout only). `bun run typecheck` now checks `src/mcp` as
  well, and runs `typecheck:prepare` itself (about 4 s), so it never checks the
  tests against a stale SDK or package build.
- **Tests run what they should.**
  - `bun test` and `bun run test:model` skip the stale test copies under
    `artifacts/`; on one developer machine, `test:model` had run 150 files
    instead of 6.
  - Server-startup tests relaunch on fresh ports after a bind collision.
  - The TCP and embedded runners count the assertions of scripts that print
    `Results: …` summaries; `test-websocket.ts` was reported as 0/0 instead of
    47 passed.
  - The Go SDK e2e harness relaunches a server that lost its port to another
    process.
- **CI.** A change that touches only TypeScript under `docs/` now runs the type
  check and the test jobs. The release-only Docker image build type-checks
  `src` with `bun check --no-script`; no published image was affected.
- **Docs.** The TLS guide has a new
  [Renewing certificates](/guide/tls/#renewing-certificates) section. The
  [2.9.21 release post](/blog/bunqueue-v2-9-21/) is now a full write-up, with
  diagrams of the worker event traffic and of a corrupted `Float32Array`, and
  the call-count matrix (169 functions by 19 scenarios) that confirmed both
  changes.

## Bugfixes

- **A parent failed by several siblings at once reports its failure once.**
  When two or more children with `failParentOnFailure` failed at the same
  moment under the same parent, the parent went to the DLQ once, but its
  `failed` event and the parent-level `flow:failed` dashboard event were emitted
  once per sibling, each with a different reason. Webhooks, event subscribers
  and `waitUntilFinished` callers saw it fail more than once. Now only the call
  that moved the parent reports it, with that child's reason. A plain two-level
  parent with two failing children had the same duplicate. PostgreSQL mode was
  not affected.
- **PostgreSQL: no phantom flow-failure value on a completed parent.** A
  propagated `ignore`/`continue` record could be written while the next parent's
  edge was still visible. A sibling's `continueParentOnFailure` could then
  release that parent, which ran and completed before the record committed, so
  `getIgnoredChildrenFailures()` / `getFailedChildrenValues()` reported a
  failure on the completed parent. The applier and the recovery sweep now drop a
  record without its edge on a `completed` parent, as they already did on a
  `failed` or missing one.
- **PostgreSQL: the flow-failure recovery sweep is bounded.** It no longer
  clears a whole backlog in one run. Each run (startup or one lease-recovery
  tick) reads at most 10 pages of 100 records. Each broker keeps its cursor in
  memory, so the next run continues where the previous one stopped and wraps
  around to older records. Broker readiness no longer waits on an unbounded
  startup sweep. A crash backlog drains at up to 1,000 records per tick (every
  15 s with the default 30 s lease) on each live broker.

## How these numbers were measured

- **`ACKB` throughput:** measured on the change itself, commit `cf21d8bf`,
  before and after it, not on the final 2.9.22 tree. Native macOS arm64 with
  Bun 1.4.4, a fresh broker and SQLite database per run, 50,000 jobs, worker
  concurrency 50 and batch size 50, three alternating runs. These are native
  host diagnostics, not publication benchmarks.
- **Stuck flow parents:** a production-style FlowProducer campaign of 50,100 jobs
  with broker SIGKILLs.
- **PostgreSQL repair:** the figures are ceilings set by the slice size (at most
  1,000 edges) and the 250 ms pause after each slice.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.9.21](/blog/bunqueue-v2-9-21/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.9.22) · [Commits since v2.9.21](https://github.com/egeominotti/bunqueue/compare/v2.9.21...v2.9.22) · [Full changelog](/changelog/) · [All posts](/blog/)
