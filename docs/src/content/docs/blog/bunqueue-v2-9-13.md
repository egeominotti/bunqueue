---
title: "bunqueue v2.9.13"
description: "Fixes 7 bugs. Re-adding a finished custom jobId, or replacing a deduplicated job, without durable could lose both generations on a crash."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-9-13.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-10-09"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.9.13</em></h1>
  <p class="bq-hero-sub">Fixes 7 bugs. Re-adding a finished custom jobId, or replacing a deduplicated job, without durable could lose both generations on a crash.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.9.13

```bash title="bun"
bun add bunqueue@2.9.13
```

```bash title="npm"
npm install bunqueue@2.9.13
```

```bash title="docker"
TAG=2.9.13
docker run -p 6789:6789 -p 6790:6790 ghcr.io/egeominotti/bunqueue:$TAG
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

**Data loss**

- **Re-adding a finished custom `jobId`, or replacing a deduplicated job,
  without `durable` could lose both generations on a crash.** With SQLite
  persistence the old generation (a completed job with its result, a DLQ
  entry, or the replaced deduplication owner) was deleted at once while its
  successor waited up to 10 ms in the write buffer; a crash in that window
  left neither on disk. The deletion and the new row now commit in one
  transaction for `add`, `addBulk` and `deduplication.replace`, including a
  replace while the owner is active, with or without `durable`. These adds
  already paid that synchronous transaction, so they are no slower; plain adds
  stay buffered. PostgreSQL was already atomic.
- **An embedded `Queue.close()` followed by `process.exit()` lost the last
  jobs it added.** Buffered (non-durable) adds reach SQLite every 10 ms or
  every 100 jobs, and `close()` / `disconnect()` returned without writing the
  rest: awaiting 10, 50 or 99 `add()` calls, or one `addBulk()` of 42 jobs,
  then `close()` and `process.exit(0)` persisted none of them, and 150 adds
  persisted 100. Closing an embedded Queue now writes the write buffer before
  it returns. The flush is best effort, so `close()` stays synchronous and
  never throws, and it respects the write buffer's retry backoff: after a
  failed write, `close()` writes nothing until the scheduled retry runs, so
  closing queues never uses up the buffer's ten retry attempts, and those rows
  are retried, and reported if finally lost, exactly as before. `close()`
  still leaves the process-wide manager and its timers running; call
  `shutdownManager()` to let the process exit. TCP queues and the PostgreSQL
  backend are unchanged. `test/repro-embedded-close-exit-loses-buffered-jobs.test.ts`,
  `test/repro-embedded-close-respects-writebuffer-backoff.test.ts` and
  `test/embedded-queue-close-flush.test.ts` pin the behaviour.

**Graceful restarts**

- **A graceful restart no longer charges jobs that never failed.** On SIGTERM
  or SIGINT the TCP and HTTP listeners were closed before the active-job drain,
  so a worker could not ACK the job it was running: the drain always waited the
  whole `SHUTDOWN_TIMEOUT_MS` (30 s, longer than `docker stop`'s 10 s grace)
  and the job stayed `active` on disk. Startup recovery then charged it an
  attempt and a stall, so a job whose processor succeeded during shutdown was
  `failed` in the DLQ after restart (`attempts: 1`) or ran again (`attempts:
  3`). Shutdown now first stops accepting connections and handing out jobs
  (`PULL`/`PULLB`, including long polls already waiting, return no job), keeps
  the open TCP connections and WebSockets served so workers can ACK, FAIL,
  heartbeat and report progress, and ends the drain as soon as no job is
  active. Only then does it close TCP and HTTP and shut storage down. Jobs
  still active at the deadline are left to the next process's recovery, as
  before. During the drain a pull with a timeout delivers nothing and holds
  until its own timeout or until its connection closes, so a long-polling
  worker re-polls once per poll timeout instead of every 10 ms; a pull without
  a timeout returns empty at once. Other commands, `PUSH`/`PUSHB` included,
  keep working on open connections during the drain and are persisted. Plain
  HTTP requests need a new connection and are refused once shutdown starts.
- **A job released by a disconnecting worker keeps its attempts across a
  restart.** When a worker connection closed, its never-renewed job went back
  to `waiting` in memory with no attempt charged, but SQLite kept it `active`,
  so a restart charged it (to the DLQ for `attempts: 1`). The release is now
  written to SQLite (`waiting`, `prioritized` or `delayed`, `started_at`
  cleared, attempts unchanged), including for a job still in the write buffer.
  PostgreSQL already stored this release.
- **A job returned to its queue by a failed pull handoff keeps its attempts
  across a restart.** When a pull was cancelled or failed after the job had
  already been stored `active` (for example a throwing `pulled` listener), the
  job went back to its queue in memory but SQLite kept it `active`, so a
  restart charged it an attempt. The requeue is now written to SQLite as well,
  and the stray `active` entry that dequeue appended is removed from the job's
  timeline (`getJob().timeline`).
- **With PostgreSQL, a cancelled pull claims nothing.** A pull whose signal was
  aborted (its client disconnected, or the server started draining) while it
  waited for readiness, the write flush or admission could still claim a job;
  the signal is now checked right before every claim. A claim already running
  in the database when the signal aborts still completes and is delivered.

**Python SDK**

- **Python SDK: closing a client now ends its TCP connection on Linux.** The
  SDK's reader thread stays blocked in `recv()`, and on Linux closing a socket
  that another thread is reading neither wakes that thread nor sends FIN. So
  `Queue.close()`, `Worker.close()`, the context managers and every other
  close path left the connection open on the broker until the Python process
  exited. A job it had leased and not acknowledged stayed `active` until its
  lock expired (`lockTtl`, 30 s by default) instead of returning to `waiting`
  at once. With the graceful shutdown above, which keeps open connections
  served while it waits for active jobs, such a job held a server restart for
  the whole `SHUTDOWN_TIMEOUT_MS` (30 s). That is how the Python SDK
  integration job in CI failed: its teardown gives the server 10 s to exit.
  Teardown now shuts the socket down, and only the reader thread closes it,
  once it has stopped reading, so the descriptor is never reused while a TLS
  alert can still be written through it. macOS was not affected, and the other
  official SDKs never close a socket while another thread is reading it. The
  fix ships in Python `bunqueue-client` 0.2.1, published to PyPI by hand;
  `sdk/python/tests/e2e_connection_close.py` pins it.

## Testing

- **The test sandbox image now ships `jq`.** The `docker-sbom` digest test
  executes the CI workflow step, which pipes the image manifest through `jq`
  as GitHub's `ubuntu-latest` runners provide it; inside `bun run
  test:sandbox` the command was missing (exit 127), so that test failed on
  every sandbox run. `Dockerfile.test` installs it next to `ca-certificates`
  and `openssl`.
- **The broker model's crash restart now models a crash.** `stopModelBroker`
  closed the model client before sending `SIGKILL`, so the broker could run
  the disconnect release first. Now that the release is persisted, a held job
  was charged or not depending on which event the broker saw first
  (`test/repro-model-repeated-crash-stall-bound.test.ts` failed in the Linux
  sandbox and passed on macOS; with a 300 ms gap before the kill it failed 3/3).
  The broker is now killed while the client is still connected, and the client
  is closed afterwards.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.9.12](/blog/bunqueue-v2-9-12/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.9.13) · [Commits since v2.9.12](https://github.com/egeominotti/bunqueue/compare/v2.9.12...v2.9.13) · [Full changelog](/changelog/) · [All posts](/blog/)
