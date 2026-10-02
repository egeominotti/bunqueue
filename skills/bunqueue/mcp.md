# bunqueue MCP Server

bunqueue includes a native MCP (Model Context Protocol) server for AI agent integration. 75 tools, 5 resources, 3 diagnostic prompts, plus 3 opt-in workflow tools (`BUNQUEUE_MCP_WORKFLOW_DB`).

## Setup

> `bunqueue-mcp` is a binary bundled inside the `bunqueue` package — there is no standalone `bunqueue-mcp` package on npm. `bunx --package=bunqueue bunqueue-mcp` tells `bunx` which package provides the binary (running it as a bare `bunx bunqueue-mcp`/`npx bunqueue-mcp` without first installing `bunqueue` yields `404 bunqueue-mcp`). Alternatively `bun add -g bunqueue` once, then `bunx bunqueue-mcp`.
>
> **MCP SDK (v2.8.0+):** `@modelcontextprotocol/sdk` is an **optional peer dependency** — queue-only installs skip it (and its zod + HTTP transitive deps), and `bunx --package=bunqueue` does not auto-install it. A clean `bun add bunqueue` pulls only 7 packages / 5.4 MB into `node_modules` (down from 117 packages / 93 MB). To run the MCP server, install the SDK once: `bun add @modelcontextprotocol/sdk`. If it's missing, the launcher exits with code 1 and prints `[bunqueue-mcp] The MCP server requires "@modelcontextprotocol/sdk" (an optional peer dependency). Install it with:  bun add @modelcontextprotocol/sdk`.

### Claude Code (claude_desktop_config.json or .mcp.json)

```json
{
  "mcpServers": {
    "bunqueue": {
      "command": "bunx",
      "args": ["--package=bunqueue", "bunqueue-mcp"],
      "env": {
        "BUNQUEUE_MODE": "embedded",
        "DATA_PATH": "./data/bunq.db"
      }
    }
  }
}
```

### TCP Mode (connect to remote server)

```json
{
  "mcpServers": {
    "bunqueue": {
      "command": "bunx",
      "args": ["--package=bunqueue", "bunqueue-mcp"],
      "env": {
        "BUNQUEUE_MODE": "tcp",
        "BUNQUEUE_HOST": "localhost",
        "BUNQUEUE_PORT": "6789",
        "BUNQUEUE_TOKEN": "secret"
      }
    }
  }
}
```

All 75 tools behave the same in both modes. HTTP handlers follow the mode: in TCP mode their workers process the remote server's jobs and the MCP process never opens a local database. `bunqueue_get_stats` fields differ (TCP: push/pull rates; embedded: prioritized, waiting-children, lifetime and cron totals).

### Streamable HTTP transport (several clients, one server)

stdio is the default. `BUNQUEUE_MCP_TRANSPORT=http` serves MCP Streamable HTTP on `http://127.0.0.1:6791/mcp`, one session per client, all sharing one backend and one set of HTTP handlers:

```bash
BUNQUEUE_MCP_TRANSPORT=http BUNQUEUE_MCP_HTTP_TOKEN=change-me bunx --package=bunqueue bunqueue-mcp
claude mcp add --transport http bunqueue http://127.0.0.1:6791/mcp --header "Authorization: Bearer change-me"
```

- `BUNQUEUE_MCP_HTTP_HOST` (default `127.0.0.1`), `_PORT` (`6791`, `0` = free port), `_PATH` (`/mcp`).
- `BUNQUEUE_MCP_HTTP_TOKEN`: comma-separated bearer tokens. Optional on loopback, **required** on any other host (the server refuses to start without one).
- `Host`/`Origin` are checked (DNS-rebinding protection): add proxy names to `BUNQUEUE_MCP_HTTP_ALLOWED_HOSTS` (`name` or `name:port`) and browser origins to `BUNQUEUE_MCP_HTTP_ALLOWED_ORIGINS`. Otherwise 403.
- `BUNQUEUE_MCP_HTTP_MAX_SESSIONS` (100, then 503) and `BUNQUEUE_MCP_HTTP_SESSION_TTL_MS` (30 min idle; never while a tool call runs). Sessions are in memory: a restart ends them (404, reconnect).
- No built-in TLS: keep it on loopback behind a TLS reverse proxy, and still set a token.

### Opt-in agent features (all off by default)

- `BUNQUEUE_MCP_TOOLSETS`: `queues,dlq` exposes only those toolsets; `dynamic` (optionally `dynamic,monitoring`) starts from a catalog with `bunqueue_enable_toolsets` and `bunqueue_call_tool`. Full list ≈16,000 tokens; catalog + one toolset ≈1,300–4,600 (≈1,800 typical).
- `BUNQUEUE_MCP_CONFIRM=destructive`: annotates every tool; `obliterate_queue`, `drain_queue`, `clean_queue`, `purge_dlq`, `cancel_job`, `clear_job_logs`, `delete_cron`, `remove_webhook`, bulk `retry_completed` (and `signal_workflow` with workflow tools) return their impact with `executed: false` until the user confirms via elicitation, or the agent calls again with `confirm` set to the exact target after the user approved.
- `BUNQUEUE_MCP_DECISION_*`: decision model (Jev, Clef, Clef-flash, Kev 9B, Laya) for `bunqueue_find_tools` and an extra check on unconfirmed destructive calls (`userRequest`). It can only block.
- `BUNQUEUE_MCP_WORKFLOW_DB`: see Workflow approvals below.

An invalid `BUNQUEUE_MCP_*` value stops the server at startup.

## Available Tools (75, by toolset)

### jobs (12)
- `bunqueue_add_job` — Add a job (options below)
- `bunqueue_add_jobs_bulk` — Add multiple jobs at once (same options per item)
- `bunqueue_get_job` — Get job by ID, with its state and options
- `bunqueue_get_job_by_custom_id` — Get an unfinished job by custom ID
- `bunqueue_get_job_state` — Get job state
- `bunqueue_get_job_result` — Get job result
- `bunqueue_wait_for_job` — Wait for job to complete (`Job not found` for an unknown id)
- `bunqueue_get_progress` — Get job progress (any state)
- `bunqueue_update_progress` — Update job progress
- `bunqueue_get_job_logs` — Get job logs
- `bunqueue_add_job_log` — Add log entry
- `bunqueue_clear_job_logs` — Clear logs (`keepLogs` keeps the newest)

### job-control (7)
- `bunqueue_cancel_job` — Cancel a waiting or delayed job
- `bunqueue_discard_job` — Move a job to the DLQ without processing it
- `bunqueue_promote_job` — Promote delayed job to waiting
- `bunqueue_update_job_data` — Update job data
- `bunqueue_change_job_priority` — Change job priority
- `bunqueue_move_to_delayed` — Move job to delayed
- `bunqueue_change_delay` — Change the delay of a delayed job

### processing (8)
- `bunqueue_pull_job` — Pull a job (`owner`/`lockTtl` lock it and return a `token`)
- `bunqueue_pull_job_batch` — Pull multiple jobs
- `bunqueue_ack_job` — Complete a job (`token` for locked jobs)
- `bunqueue_ack_job_batch` — Batch complete (`tokens`, one per id)
- `bunqueue_fail_job` — Fail a job (`token`, `unrecoverable`)
- `bunqueue_job_heartbeat` — Heartbeat; with `token` it renews the lock
- `bunqueue_job_heartbeat_batch` — Batch heartbeats (`tokens`)
- `bunqueue_extend_lock` — Extend a job lock (`token`, `duration` up to 24 h)

### queues (11)
- `bunqueue_list_queues` — List all queues
- `bunqueue_count_jobs` — Count jobs in every state
- `bunqueue_get_jobs` — List jobs by state (incl. `prioritized`, `paused`, `waiting-children`)
- `bunqueue_get_job_counts` — Job counts per state
- `bunqueue_get_counts_per_priority` — Queued job counts per priority
- `bunqueue_is_paused` — Check if queue is paused
- `bunqueue_pause_queue` — Pause a queue
- `bunqueue_resume_queue` — Resume a queue
- `bunqueue_drain_queue` — Remove waiting, prioritized and delayed jobs
- `bunqueue_clean_queue` — Remove old completed/failed jobs (never waiting ones)
- `bunqueue_obliterate_queue` — Delete everything

### dlq (5)
- `bunqueue_get_dlq` — DLQ entries with failure `reason`, error and attempt history (filter `reason`, page `limit`/`offset`)
- `bunqueue_get_dlq_stats` — Total, per reason, pending retry, expired, oldest/newest
- `bunqueue_retry_dlq` — Retry one (`jobId`) or all DLQ jobs
- `bunqueue_purge_dlq` — Purge DLQ
- `bunqueue_retry_completed` — Retry completed jobs

### cron (4)
- `bunqueue_add_cron` — Schedule a cron or interval job (options below)
- `bunqueue_list_crons` — List schedules
- `bunqueue_get_cron` — Get schedule details
- `bunqueue_delete_cron` — Delete a schedule

### limits (5)
- `bunqueue_set_rate_limit` — Rate limit: `limit` jobs per `duration` ms (default 1000)
- `bunqueue_clear_rate_limit` — Clear rate limit
- `bunqueue_set_concurrency` — Concurrency limit (integer ≥ 1)
- `bunqueue_clear_concurrency` — Clear concurrency limit
- `bunqueue_get_queue_limits` — Read limits, active count, whether they hold jobs back, paused

### flows (5)
- `bunqueue_add_flow` — Create parent-child flow
- `bunqueue_add_flow_chain` — Create sequential chain
- `bunqueue_add_flow_bulk_then` — Fan-out/fan-in flow
- `bunqueue_get_flow` — Get flow tree
- `bunqueue_get_children_values` — Get child job results

### workers (7)
- `bunqueue_register_worker` — Register a worker
- `bunqueue_unregister_worker` — Unregister a worker
- `bunqueue_worker_heartbeat` — Worker heartbeat
- `bunqueue_list_workers` — List active workers
- `bunqueue_register_handler` — Auto-process jobs via HTTP
- `bunqueue_unregister_handler` — Remove handler
- `bunqueue_list_handlers` — List active handlers

### webhooks (4)
- `bunqueue_add_webhook` — Register a webhook
- `bunqueue_remove_webhook` — Remove a webhook
- `bunqueue_list_webhooks` — List all webhooks
- `bunqueue_set_webhook_enabled` — Enable/disable webhook

### monitoring (7)
- `bunqueue_get_stats` — Global server stats
- `bunqueue_get_queue_stats` — Job counts for one queue
- `bunqueue_get_per_queue_stats` — Job counts for every queue
- `bunqueue_get_memory_stats` — Memory usage
- `bunqueue_get_storage_status` — Storage status
- `bunqueue_get_prometheus_metrics` — Prometheus format
- `bunqueue_compact_memory` — Force memory compaction

### workflows (3, opt-in with `BUNQUEUE_MCP_WORKFLOW_DB`)
- `bunqueue_list_workflow_executions` — List runs (filter `workflowName`, `state`; page `limit`/`offset`)
- `bunqueue_get_workflow_execution` — One run: steps, signals, input, failure
- `bunqueue_signal_workflow` — Deliver a `waitFor` signal, like `engine.signal()` (first signal wins)

## Key parameters

- **Job options** (`add_job`, each `add_jobs_bulk` item): `priority`, `delay`, `attempts`, `backoff` (number = exponential base, or `{ type: 'fixed' | 'exponential', delay, maxDelay }`), `timeout`, `jobId` (idempotent while the job is unfinished), `deduplication` (`{ id, ttl, extend, replace }`), `removeOnComplete`, `removeOnFail`, `durable`, `lifo`, `tags`, `stallTimeout`. Flow `opts` take the same except `deduplication`, `tags`, `durable` (rejected).
- **Locks:** `pull_job`/`pull_job_batch` with `owner` (+ `lockTtl`, 1 s–24 h, default 30 s) return a `token` per job. Ack/fail without the right token is an error (`Lock token required for job <id>`); `move_to_delayed`, `change_delay` and `discard_job` reject locked jobs.
- **DLQ reasons:** `explicit_fail`, `max_attempts_exceeded`, `timeout`, `stalled`, `ttl_expired`, `worker_lost`, `unknown`. `get_dlq` returns `{ queue, reason?, offset, count, hasMore, entries }` (each entry holds its `job`; `limit` 1–100, default 20).
- **Cron:** `timezone` (IANA, needs `schedule`), `jobName`, `priority`, `maxLimit`, `immediately`, `skipIfNoWorker`, `preventOverlap` (default on), `skipMissedOnRestart`, `deduplication`, and job options `attempts`, `backoff`, `timeout`, `delay`, `stallTimeout`, `removeOnComplete`, `removeOnFail`. List/get return `jobName`, `priority`, `timezone`, `maxLimit` only.
- Inputs are validated with the broker's bounds before anything is sent: non-empty queue/job names, integer priority within ±1,000,000, attempts 1–1000, limits ≥ 1.

## Workflow approvals

`BUNQUEUE_MCP_WORKFLOW_DB=/abs/path/workflows.db` (the Engine's existing `dataPath`; never created) enables the `workflows` toolset. `BUNQUEUE_MCP_WORKFLOW_QUEUE` must match a custom Engine `queueName` (default `__wf:steps`).

`bunqueue_signal_workflow` records the signal with the same transaction as `engine.signal()` and enqueues the run's next step job; the app's Engine runs it. Supported topology only:

1. The Engine connects over TCP with its own `dataPath`: `new Engine({ embedded: false, connection: { host, port }, dataPath })`.
2. The MCP server runs with `BUNQUEUE_MODE=tcp` against the same bunqueue server.
3. Same host, write access to the DB file, its `-wal`/`-shm` files and its directory (no network filesystem).

With an embedded Engine (the DB also holds bunqueue's `jobs` table) or an embedded MCP server, the signal tool is not registered (reason on stderr): the app must call `engine.signal()` itself. List/get still work. App `signal:received` listeners do not fire for MCP signals; untimed gates show `waitingFor: null`.

## Resources (Read-Only)

| URI | Description |
|-----|-------------|
| `bunqueue://stats` | Global server statistics |
| `bunqueue://queues` | All queues with job counts |
| `bunqueue://crons` | Scheduled cron jobs |
| `bunqueue://workers` | Active workers |
| `bunqueue://webhooks` | Registered webhooks |

## Diagnostic Prompts

| Prompt | Description |
|--------|-------------|
| `bunqueue_health_report` | Comprehensive health check with severity levels |
| `bunqueue_debug_queue` | Deep diagnostic of a specific queue, with DLQ failure reasons |
| `bunqueue_incident_response` | Step-by-step triage playbook |

## Agent Workflow Example

An AI agent can use bunqueue MCP to:

1. **Create a job**: `bunqueue_add_job` with queue, name, data
2. **Wait for result**: `bunqueue_wait_for_job` with jobId
3. **Check progress**: `bunqueue_get_progress` during processing
4. **Handle failures**: `bunqueue_get_dlq_stats`, then `bunqueue_get_dlq` filtered by `reason`
5. **Monitor health**: `bunqueue_get_stats` for system overview

Or use HTTP handlers for autonomous processing:

1. **Register handler**: `bunqueue_register_handler` with queue and endpoint URL
2. **Add jobs**: `bunqueue_add_job` — they auto-process via HTTP to your endpoint
3. **Check results**: `bunqueue_get_job_result` to see HTTP responses

Handlers run inside the MCP process: over stdio they stop when the session ends; over HTTP they keep running until the server stops.
