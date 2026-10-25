---
title: "bunqueue v2.8.10"
description: "Fixes 19 bugs. A typo no longer boots a server."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-10.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-06-11"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.10</em></h1>
  <p class="bq-hero-sub">Fixes 19 bugs. A typo no longer boots a server.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.10

```bash title="bun"
bun add bunqueue@2.8.10
```

```bash title="npm"
npm install bunqueue@2.8.10
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

A deep CLI audit (same parameter-honoring bug class as the #95 API audit, one
layer up) surfaced ~25 issues. This release fixes the critical and high ones:

- **A typo no longer boots a server.** The `bunqueue` binary entry point fell
  through to `startServer()` for any unrecognized first argument, so
  `bunqueue stast` (typo), `bunqueue version`, `bunqueue doctor` or
  `bunqueue ping` silently started a full server (bound ports, created the
  default DB) instead of running the CLI. The server now boots only for a
  bare `bunqueue`, `start`, or flag-led invocations; everything else routes
  to the CLI, and unknown commands exit 1 with an error.
- **`cron add --max-limit 0` now means unlimited** as the help always said.
  Previously the server interpreted 0 as "already exhausted" and the cron
  never fired. Negative values are rejected.
- **Global `-t` no longer steals `pull`/`job wait` timeouts.**
  `bunqueue pull q -t 5000` used to send `Auth { token: "5000" }`; `-t` after
  `pull`/`job` is now passed through to the subcommand (long `--token` is
  global everywhere, `-t` before the command still works as token).
- **`webhook add` event list matches reality.** It accepted events the server
  never emits (`job.active`, `job.waiting`, `job.delayed`, webhooks created
  but permanently dead) and rejected the actually-emitted
  `job.pushed`/`job.started`. Valid events now: `job.pushed`, `job.started`,
  `job.completed`, `job.failed`, `job.progress`.
- **`bunqueue backup` honors `BUNQUEUE_DATA_PATH`/`BQ_DATA_PATH`** (canonical
  data-path priority) instead of only `DATA_PATH`/`SQLITE_PATH`.
- **Long-poll commands no longer die on the client's own 30s timeout.** For
  `PULL`/`WaitJob` (only, on PUSH `timeout` is the job execution timeout and
  does not stretch the client wait) the CLI timeout scales with the command's
  `timeout` field (+10s buffer), so `pull --timeout 30000` and
  `job wait --timeout 60000` wait as requested.
- **`job wait` that times out now exits 1** with "Job not completed within
  timeout" instead of printing a green `OK` (exit 0) indistinguishable from
  success.
- **`cron add --every` rejects non-positive intervals.** A negative interval
  produced a `nextRun` permanently in the past, the cron fired on every
  scheduler tick, indefinitely. `job wait --timeout` rejects negatives too.
- **Global value flags no longer swallow a following flag**: `--token --json`,
  `-H --json`, `-p --json` now warn and keep `--json` working (same guard
  `--tls-ca` already had).
- Unknown commands and parse errors are now reported without requiring a
  reachable server (command is built before connecting).

**Audit pass 3, parsing, formatters, cross-layer:**

- **Entry points unified**: `bunqueue start` now boots the SAME full server as
  a bare `bunqueue` (shared bootstrap), S3 backup, cloud agent, stats
  interval, crash handlers and graceful drain were previously missing from
  the `start` path. Also fixes `HTTP_SOCKET_PATH` being shown in the banner
  but never applied on the bare entry.
- **Short `-h`/`-v` are global only before the command**: `push q '{}' -h host`
  (typo of `-H`) used to print help and exit 0 without pushing, a false
  success in scripts. Long `--help`/`--version` stay global; `--help` after
  `push`/`cron` now shows command-specific help.
- **`--` separator**: everything after `--` is opaque to the global parser
  (no more `--json`/`-t` stolen from values).
- **Attached short flags warn**: `push q '{}' -p10` silently dropped the
  priority and pushed anyway; now a warning points to the separated form.
- **Cron `maxLimit` fixed at the domain level**: 0/negative store `null`
  (unlimited) on EVERY surface, TCP, HTTP API and MCP no longer create
  permanently-exhausted crons.
- **Webhook events validated server-side** against a single canonical list
  (`WEBHOOK_EVENTS`) shared by CLI, TCP/HTTP handler and MCP, previously the
  server accepted any string and MCP advertised events that don't exist.
- **`WaitJob` timeout capped server-side** (0–600000 ms, like `PULL`), an
  unbounded wait could hold client and connection for days.
- **Formatters stop dropping operational data**: `worker list` shows status
  (stale workers are now visible), concurrency and job counters;
  `webhook list` shows enabled state, queue and delivery counters;
  `cron list` shows next run / max / timezone; `stats` shows uptime and
  push/pull rates; `webhook add` prints the webhookId (needed for remove);
  `cron add` prints the next run.
- **`job state` of a missing job exits 1** ("Job not found") instead of
  printing `State: unknown` with exit 0.

Remaining low audit findings are tracked for a follow-up release.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.9](/blog/bunqueue-v2-8-9/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.10) · [Commits since v2.8.9](https://github.com/egeominotti/bunqueue/compare/v2.8.9...v2.8.10) · [Full changelog](/changelog/) · [All posts](/blog/)
