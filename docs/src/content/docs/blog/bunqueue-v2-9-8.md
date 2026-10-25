---
title: "bunqueue v2.9.8"
description: "Fixes 14 bugs. Streamable HTTP transport (BUNQUEUE_MCP_TRANSPORT=http)."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-9-8.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-10-03"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.9.8</em></h1>
  <p class="bq-hero-sub">Fixes 14 bugs. Streamable HTTP transport (BUNQUEUE_MCP_TRANSPORT=http).</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.9.8

```bash title="bun"
bun add bunqueue@2.9.8
```

```bash title="npm"
npm install bunqueue@2.9.8
```

```bash title="docker"
TAG=2.9.8
docker run -p 6789:6789 -p 6790:6790 ghcr.io/egeominotti/bunqueue:$TAG
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Breaking changes

- **`bunqueue_get_dlq` returns entries instead of jobs.** The output is
  `{ queue, reason?, offset, count, hasMore, entries }`, with each entry's
  `job` inside it; the top-level `jobs` array is gone. `limit` must be an
  integer from 1 to 100 (default 20).
- **Stricter MCP inputs, in both modes.** `bunqueue_set_rate_limit` and
  `bunqueue_set_concurrency` need integers of at least 1.
  `bunqueue_add_cron` needs a non-empty `name`, an integer `repeatEvery` of
  at least 1, an integer `priority` within ±1,000,000, and a `timezone` that
  is a known IANA zone and comes with a `schedule`. Flow `opts` reject
  unknown keys, including `deduplication`, `tags` and `durable`, instead of
  dropping them. `bunqueue_extend_lock` caps `duration` at 24 hours, and
  `lockTtl` requires `owner`. `bunqueue_move_to_delayed` and
  `bunqueue_change_delay` cap `delay` at one year like the add tools;
  `bunqueue_clean_queue` `limit`, `bunqueue_get_jobs` `start`/`end` and
  `bunqueue_get_flow` `depth`/`maxChildren` must be integers (`limit`,
  `depth` and `maxChildren` at least 1); `bunqueue_get_cron` and
  `bunqueue_delete_cron` reject an empty name. A rejected call changes
  nothing.
- **`bunqueue_wait_for_job` fails with "Job not found" for an unknown id**
  instead of waiting out the timeout, in both modes.

## MCP server

`bunqueue-mcp` now has 75 tools (73 before) plus 3 opt-in workflow tools. A
client that sets none of the new variables still runs over stdio and sees the
same tools, two new ones and new optional parameters; the output and input
changes are listed under Breaking changes below.

- **Streamable HTTP transport (`BUNQUEUE_MCP_TRANSPORT=http`).** One
  long-running server serves several MCP clients, one session each, sharing a
  single queue connection and one set of HTTP handlers. It listens on
  `http://127.0.0.1:6791/mcp` by default (`BUNQUEUE_MCP_HTTP_HOST`, `_PORT`,
  `_PATH`) and accepts the bearer tokens in `BUNQUEUE_MCP_HTTP_TOKEN`,
  compared in constant time; on a non-loopback address it refuses to start
  without one. `Host` and `Origin` are checked against the bound address and
  `BUNQUEUE_MCP_HTTP_ALLOWED_HOSTS` / `_ALLOWED_ORIGINS` to block DNS
  rebinding. Sessions are capped (`_MAX_SESSIONS`, default 100) and closed
  after 30 idle minutes (`_SESSION_TTL_MS`), never while a tool call is
  running. There is no built-in TLS: put a reverse proxy in front.
- **Workflow approvals from the agent (`BUNQUEUE_MCP_WORKFLOW_DB`).**
  `bunqueue_list_workflow_executions`, `bunqueue_get_workflow_execution` and
  `bunqueue_signal_workflow` read the workflow Engine's database and deliver
  human-in-the-loop signals through the same first-writer-wins transaction as
  `engine.signal()`; the application's Engine runs the resumed step. Signals
  need the Engine connected over TCP with its own `dataPath`, the MCP server
  in TCP mode against the same broker, and the file on the same host. With an
  embedded Engine, or an embedded MCP server, the signal tool is not
  registered and stderr says why. The server never creates the database: a
  missing file, or one without the workflow tables, stops startup.
  `BUNQUEUE_MCP_WORKFLOW_QUEUE` names a non-default Engine queue.
- **Job options.** `bunqueue_add_job` and each `bunqueue_add_jobs_bulk` item
  accept `backoff` (a number, or `{ type, delay, maxDelay }`), `timeout`,
  `jobId`, `deduplication` (`{ id, ttl, extend, replace }`),
  `removeOnComplete`, `removeOnFail`, `durable`, `lifo`, `tags` and
  `stallTimeout`, next to `priority`, `delay` and `attempts` (new on bulk
  items). The flow tools accept the same `opts` except `deduplication`,
  `tags` and `durable`. `bunqueue_get_job` and job listings return the
  options a job carries.
- **Lock tokens.** `bunqueue_pull_job` and `bunqueue_pull_job_batch` take
  `owner` and `lockTtl`; each job then comes back with a `token` that
  `bunqueue_ack_job`, `bunqueue_fail_job` and `bunqueue_job_heartbeat` accept
  (`tokens` on the batch tools). A heartbeat with the token renews the lock,
  and `bunqueue_fail_job` takes `unrecoverable` to go straight to the DLQ.
- **DLQ failure reasons and statistics.** `bunqueue_get_dlq` returns each
  entry's `reason`, last error, recent attempt history, retry count and retry
  and expiry times, filters by `reason` and pages with `offset`. The new
  `bunqueue_get_dlq_stats` returns the total, the entries per reason, the
  entries due for automatic retry, the expired entries and the oldest and
  newest entry. The `bunqueue_debug_queue` and `bunqueue_incident_response`
  prompts use both instead of a short job list.
- **Queue limits.** The new `bunqueue_get_queue_limits` reads a queue's rate
  limit, concurrency limit and active jobs, whether either limit is holding
  jobs back, and whether the queue is paused. `bunqueue_set_rate_limit` takes
  `duration` (the window in ms, default 1000), so limits per minute or per
  hour are possible.
- **Cron options.** `bunqueue_add_cron` takes `timezone`, `jobName`,
  `priority`, `maxLimit`, `immediately`, `skipIfNoWorker`, `preventOverlap`,
  `skipMissedOnRestart`, `deduplication` and options for the jobs it adds
  (`attempts`, `backoff`, `timeout`, `delay`, `stallTimeout`,
  `removeOnComplete`, `removeOnFail`). Add, list and get return `jobName`,
  `priority`, `timezone` and `maxLimit`; the policy flags, deduplication and
  job options are applied but not returned, because the broker's cron reply
  does not carry them.
- **Load only the tools an agent needs (`BUNQUEUE_MCP_TOOLSETS`).** The 75
  tools are grouped into 11 toolsets (12 with the workflow tools). A list
  such as `queues,dlq` exposes only those groups; `dynamic` starts the agent
  from a catalog and loads groups on demand (`bunqueue_enable_toolsets`, with
  `bunqueue_call_tool` for clients that do not refresh their tool list). The
  full list costs about 16,000 tokens of context per request; the catalog
  with one toolset loaded costs 1,300 to 4,600 (about 1,800 for a typical
  toolset). On the 11 always-on toolsets, TypeSafe Jev routed 71 of 72 test
  requests to the right toolset, and 72 of 72 after the description involved
  in the miss was reworded; the requests, the script and the results are in
  `scripts/mcp-eval/`.
- **Confirm destructive operations (`BUNQUEUE_MCP_CONFIRM=destructive`).**
  Every tool gets MCP annotations (read-only, destructive, idempotent,
  open-world). Nine tools that delete data for good or re-run work in bulk
  (`obliterate_queue`, `drain_queue`, `clean_queue`, `purge_dlq`,
  `cancel_job`, `clear_job_logs`, `delete_cron`, `remove_webhook`, bulk
  `retry_completed`), plus `signal_workflow` when the workflow tools are
  enabled, first show their concrete impact and run only after the user
  confirms through the client, or, in clients that cannot ask, after the
  agent repeats the exact target in `confirm`. Previews count paused jobs,
  and `purge_dlq` states the exact number of entries it deletes.
- **Decision models (`BUNQUEUE_MCP_DECISION_*`).** One client for the
  SystemOne request format serves TypeSafe Jev, Cloudflare Clef and
  Clef-flash on Workers AI, and any compatible self-hosted endpoint (Clef,
  Clef-flash, Kev 9B, Laya, DiffusionGemma Jev). It powers
  `bunqueue_find_tools` and an extra check on destructive calls when the
  client cannot ask the user: the model must judge that the user's own words
  ask for exactly that operation. The model can only block a call, and any
  model error refuses it.

## Workflow engine

- **A signal racing a `waitFor` timeout from another process could be
  reported as resuming a run that then failed.** When a timed gate expired,
  the worker re-read the run, found no signal, and then wrote `failed`
  without checking again. A signal recorded in between from another
  connection (a second application process, or the MCP server) was accepted
  with `resumed: true`, yet the run failed by timeout and was compensated.
  The expiry is now one `IMMEDIATE` transaction that fails the run only if it
  is still parked at that gate without the signal, so whichever side commits
  first wins: a late signal is rejected, and a signal that wins keeps the run
  going. `signal:timeout` is now emitted only after the failure is saved, and
  never when the signal wins. Regressions:
  `test/repro-workflow-signal-timeout-race.test.ts`,
  `test/workflow-signal-timeout-claim.test.ts`.

## MCP server fixes

Most of these affected TCP mode (`BUNQUEUE_MODE=tcp`), where the MCP server
talks to a remote broker. Regressions: `test/repro-mcp-tcp-wire.test.ts`,
`test/repro-mcp-tool-semantics.test.ts`,
`test/repro-mcp-tcp-handler-longpoll.test.ts`,
`test/mcp-bin-tcp-handler.test.ts`, `test/mcp-flow-options.test.ts`.

- **Broker errors were reported as success in TCP mode.** A command the
  broker rejected (an invalid job, an unknown id, a wrong lock token, an
  authentication error) was treated as successful: `bunqueue_add_job`
  returned a job id that did not exist, and acknowledgements, failures and
  the true/false tools reported success. The broker's message is now returned
  as an error; "not found" and "wrong state" still return `success: false`.
- **`bunqueue_retry_dlq` with a `jobId` retried the whole DLQ in TCP mode.**
  The id was sent under a field the broker ignores. The drain, purge and
  retry counts and the batch heartbeat count read the wrong reply field and
  showed 0.
- **`bunqueue_wait_for_job` reported a timeout as a completion in TCP mode**,
  and in embedded mode waited out the whole timeout for a job that had
  already completed.
- **Webhook and worker ids were `"0"` in TCP mode.** `bunqueue_list_webhooks`
  was always empty, `bunqueue_remove_webhook` sent the wrong field, and
  registered workers showed no counters.
- **Job logs, memory statistics and Prometheus metrics were empty in TCP
  mode**, `bunqueue_get_stats` included protocol fields, and
  `bunqueue_clear_job_logs` ignored `keepLogs`.
- **`bunqueue_change_delay` sent the wrong command in TCP mode.** It used
  `MoveToDelayed`, which only accepts active jobs, so changing the delay of a
  delayed job failed.
- **A 30-second long poll failed with "Command timeout".**
  `bunqueue_pull_job` and `bunqueue_pull_job_batch` accept a `timeoutMs` of
  up to 30 s, the same as the connection's command timeout. The MCP
  connection now waits 45 s, so an empty queue returns `job: null`.
- **HTTP handlers never processed jobs in TCP mode.** Their workers always
  ran on an embedded queue inside the MCP process. They now connect to the
  remote broker, and a TCP-mode MCP server never opens a local database, even
  with `DATA_PATH` set. A broker the handler cannot reach is reported on
  stderr instead of crashing the server.
- **TCP-mode flows could go to an in-process engine.** With
  `BUNQUEUE_EMBEDDED=1` in the environment, the flow tools committed flows to
  a local engine instead of the broker.
- **`bunqueue_clean_queue` without `state` deleted waiting jobs.** The tool
  promised completed and failed jobs, but the broker read the missing state
  as `waiting`. It now cleans completed and then failed jobs, with `limit`
  capping the total, and never touches waiting, delayed or active jobs.
- **Wrong job counts.** `bunqueue_count_jobs` counted only queued jobs and
  now counts every state. A paused queue's ready jobs were counted twice in
  embedded mode (`bunqueue_get_job_counts`, `bunqueue_get_queue_stats`).
  Counts now include `waiting-children` in both modes.
- **Missing job state and progress.** `bunqueue_get_job` and
  `bunqueue_get_job_by_custom_id` now return the job's `state` (pulled jobs
  are `active`, DLQ jobs `failed`). `bunqueue_get_progress` said "not found"
  for any job that was not active; it now returns the stored progress of any
  existing job.
- **Prioritized jobs could not be listed.** `bunqueue_get_jobs` rejected the
  `prioritized` state, which holds every waiting job with a priority; it now
  also accepts `waiting-children` and `paused`.
- **Input validation.** Invalid input reached the broker or was silently
  dropped: empty queue and job names, fractional priorities, attempts and
  rate or concurrency limits, unknown flow options, and ids with broken
  Unicode that TCP mode stored mangled. These are now rejected before
  anything reaches the queue, with the same bounds the broker applies.
  Regression: `test/repro-mcp-input-bounds.test.ts`.

## Documentation

- **Generated API reference pages are `noindex, follow` and out of the
  sitemap.** 262 of the 383 sitemap URLs were near-identical TypeDoc pages,
  and Search Console reported most of the sitemap as not indexed, including
  hand-written guides such as the quickstart and installation pages. The
  generated pages stay browsable and linked from `/reference/`, and keep their
  specific titles, descriptions and self canonicals. Any
  existing `robots`, `googlebot` or `bingbot` directive on them is replaced by
  exactly one `robots` tag, and `docs:validate-discovery` now fails if a
  current reference page is indexable. The sitemap goes from 383 to 121 URLs.
- **The home page quickstart runs as written in every language.** Deno now
  gets `--allow-read` and unscoped `--allow-sys`, so the worker no longer stops
  at a permission prompt in a terminal. PHP and Go list their minimum toolchain
  versions. Elixir clones with `--depth 1`, says which `deps/0` to replace, and
  installs Hex before `mix deps.get` so a fresh machine does not prompt. Both
  "See it work" steps say that the worker keeps waiting and that
  <kbd>Ctrl</kbd>+<kbd>C</kbd> stops it.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.9.7](/blog/bunqueue-v2-9-7/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.9.8) · [Commits since v2.9.7](https://github.com/egeominotti/bunqueue/compare/v2.9.7...v2.9.8) · [Full changelog](/changelog/) · [All posts](/blog/)
