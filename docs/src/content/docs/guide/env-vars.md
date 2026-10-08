---
title: 'bunqueue Environment Variables Reference'
description: Complete environment variable reference for bunqueue, including SQLite and PostgreSQL 15–18 storage, ports, auth, backups, timeouts, and logging.
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/guide/env-vars.png
---

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">server · environment</span>
  <h1 class="bq-hero-h1 bq-bench-h1">Every environment variable, <em>one page.</em></h1>
  <p class="bq-hero-sub">The complete environment variable reference for the bunqueue server and CLI: ports, storage, auth, TLS, S3 backup, timeouts, and logging.</p>
</div>

:::tip[Prefer a config file?]
A typed `bunqueue.config.ts` can replace most of these, with IntelliSense and everything in one place. See [Configuration File](/guide/configuration/). Environment variables still work as a fallback (priority: CLI flags > config file > env vars > defaults).
:::

**Numbers are validated at startup.** Every numeric server variable must be a whole number within its range; an empty value counts as unset. Earlier releases read these variables with `parseInt`, so the forms it read as written still work: a leading `+`, a decimal fraction (dropped, as before: `SHUTDOWN_TIMEOUT_MS=1500.5` is 1500), the variable's own unit (`5000ms` for milliseconds, `512mb` for megabytes, any case) and a trailing comment from a Docker `--env-file` line (`STATS_INTERVAL_MS=60000 # 1 minute`). A value `parseInt` misread, such as `1e12` (read as `1`), `1.5e3`, `30s` (read as `30`), `5m` or `6789abc`, stops the server before it binds a port, with an error that names the variable: `Invalid STATS_INTERVAL_MS: "30s" (expected a whole number of milliseconds >= 1)`. All problems are reported at once.

**Values earlier releases tolerated keep working, with a warning.** Where an earlier release replaced an invalid value and kept running, the server keeps the same value and logs a warning that names the variable: `-1` or a value without a number disables the TCP idle timeout, the TCP write-queue cap and the monitoring thresholds; an invalid completed-job retention means "no retention"; an invalid `METRICS_MAX_QUEUES`, `BUNQUEUE_MAX_COMPLETED_JOBS` or PostgreSQL count means its default; `RATE_LIMIT_CLEANUP_MS=0` keeps the default sweep; `RATE_LIMIT_MAX_REQUESTS` without a number disables rate limiting; `WEBHOOK_RETRY_DELAY_MS` without a number or negative retries at once (0 ms). Settings of a feature that is not in use never stop the server: the `BUNQUEUE_POSTGRES_*` variables on SQLite or in-memory storage, the Cloud numbers without Cloud, `BUNQUEUE_CLOUD_INTERVAL_MS` (never applied) and the `S3_BACKUP_*` numbers with backups off are warnings.

**Booleans and words.** Every boolean variable (`S3_BACKUP_ENABLED`, `S3_VIRTUAL_HOSTED_STYLE`, `METRICS_AUTH` and the `BUNQUEUE_CLOUD_*` switches) accepts `1`/`0`, `true`/`false`, `yes`/`no` or `on`/`off`, in any case. Before, `S3_BACKUP_ENABLED=yes` silently meant false and `BUNQUEUE_CLOUD_REMOTE_COMMANDS=0` meant true. Any other word (`enabled`, `"true"` with quotes) keeps the value earlier releases gave it, with a warning: off for `S3_BACKUP_ENABLED`, `S3_VIRTUAL_HOSTED_STYLE` and `METRICS_AUTH`, on for the Cloud switches. `LOG_LEVEL` and `LOG_FORMAT` accept their values in any case, with surrounding quotes removed, and the level also accepts `warning`, `trace`, `verbose`, `fatal` and `critical`; any other word is a warning and is ignored.

**Aliases.** A legacy alias is read only when the main variable is not set at all: an empty `BUNQUEUE_MAX_COMPLETED_JOBS` means the default even when `MAX_COMPLETED_JOBS` is set, as in earlier releases.

## Server & storage

| Variable                                        | Type                 | Default     | Description                                                                    |
| ----------------------------------------------- | -------------------- | ----------- | ------------------------------------------------------------------------------ |
| `TCP_PORT`                                      | port (0-65535)       | `6789`      | TCP server port for client connections (`0` lets the OS pick one)              |
| `HTTP_PORT`                                     | port (0-65535)       | `6790`      | HTTP server port for REST API and metrics (`0` lets the OS pick one)           |
| `HOST`                                          | string               | `0.0.0.0`   | Bind address (`127.0.0.1` for local-only)                                      |
| `BUNQUEUE_STORAGE_DRIVER`                       | string               | inferred    | `memory`, `sqlite`, or `postgres`                                              |
| `BUNQUEUE_DATA_PATH`                            | string               | (in-memory) | SQLite database path. Without it or a PostgreSQL URL, jobs are lost on restart |
| `BUNQUEUE_MAX_COMPLETED_JOBS`                   | positive integer     | `50000`     | Completed-job hot cache/recovery window; does not delete durable rows          |
| `BUNQUEUE_COMPLETED_RETENTION_MS`               | non-negative integer | disabled    | Age after which the background cleanup may delete completed SQLite rows        |
| `BUNQUEUE_POSTGRES_URL`                         | string               | (none)      | PostgreSQL connection URL; implies the `postgres` driver when no driver is set |
| `BUNQUEUE_POSTGRES_NAMESPACE`                   | string               | `default`   | Isolates independent bunqueue installations in one PostgreSQL database         |
| `BUNQUEUE_BROKER_ID`                            | string               | generated   | Stable unique ID for this PostgreSQL broker process                            |
| `BUNQUEUE_POSTGRES_POOL_SIZE`                   | positive integer     | `4`         | PostgreSQL pool size (runtime minimum `2`)                                     |
| `BUNQUEUE_POSTGRES_LEASE_DURATION_MS`           | positive integer     | `30000`     | Default database-clock lease duration (runtime minimum `1000`)                 |
| `BUNQUEUE_POSTGRES_POLL_INTERVAL_MS`            | positive integer     | `250`       | Event/cron fallback polling interval (runtime minimum `25`)                    |
| `BUNQUEUE_POSTGRES_STATEMENT_TIMEOUT_MS`        | positive integer     | `30000`     | Maximum PostgreSQL statement duration (at most `2147483647`)                   |
| `BUNQUEUE_POSTGRES_LOCK_TIMEOUT_MS`             | positive integer     | `5000`      | Maximum wait for a PostgreSQL lock (at most `2147483647`)                      |
| `BUNQUEUE_POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS` | positive integer     | `30000`     | Maximum idle time inside a transaction (at most `2147483647`)                  |
| `BUNQUEUE_POSTGRES_MAX_CONCURRENT_OPERATIONS`   | positive integer     | `16`        | Active PostgreSQL manager operations per broker                                |
| `BUNQUEUE_POSTGRES_MAX_QUEUED_OPERATIONS`       | non-negative integer | `128`       | Waiting PostgreSQL manager operations before fail-fast saturation              |
| `BUNQUEUE_POSTGRES_MAX_SNAPSHOT_JOBS`           | positive integer     | `100000`    | Maximum job/result entities in one compatibility snapshot                      |
| `BUNQUEUE_POSTGRES_MAX_SNAPSHOT_PAYLOAD_BYTES`  | positive integer     | `268435456` | Maximum encoded bytes in one compatibility snapshot                            |
| `HTTP_SOCKET_PATH`                              | string               | (none)      | Unix socket for the HTTP server, replaces `HTTP_PORT`                          |
| `TCP_SOCKET_PATH`                               | string               | (none)      | **Reserved, not functional yet** (see below)                                   |
| `TLS_CERT_FILE`                                 | string               | (none)      | PEM certificate, enables native TLS on TCP + HTTP                              |
| `TLS_KEY_FILE`                                  | string               | (none)      | PEM private key matching `TLS_CERT_FILE`                                       |

```bash
BUNQUEUE_DATA_PATH=/var/lib/queue.db TCP_PORT=6789 bunqueue start
```

**Data path aliases.** Four names are read for the SQLite path, in priority order: `BUNQUEUE_DATA_PATH` > `BQ_DATA_PATH` > `DATA_PATH` > `SQLITE_PATH`. They are equivalent; prefer `BUNQUEUE_DATA_PATH`.

**Completed-job retention.** `BUNQUEUE_MAX_COMPLETED_JOBS` (legacy alias:
`MAX_COMPLETED_JOBS`) only bounds the hot in-memory projection. Durable
retention is opt-in through `BUNQUEUE_COMPLETED_RETENTION_MS` (legacy alias:
`COMPLETED_RETENTION_MS`); when unset, completed SQLite rows are retained until
an explicit clean or obliterate operation. `0` makes every unprotected
completed row eligible on the next cleanup tick. A negative or non-numeric
value disables retention, as in earlier releases, with a warning; a misread value
such as `1e12` (read as 1 ms by earlier releases) stops startup. An empty
`BUNQUEUE_COMPLETED_RETENTION_MS` disables retention even when the legacy alias
is set.

**Storage selection.** An explicit driver wins. Otherwise a PostgreSQL URL
selects PostgreSQL, a data path selects SQLite, and neither selects memory.
PostgreSQL and a SQLite data path cannot be combined. PostgreSQL is server-only,
tested in CI against majors 15, 16, 17, and the pinned/recommended 18.6 release,
and every active broker sharing a namespace must have a unique broker ID. MySQL
is not supported. In the repository Compose
topology, `POSTGRES_PASSWORD` configures the database and
`BUNQUEUE_POSTGRES_URL` configures brokers; if the secret contains URI-reserved
characters, percent-encode its password component in the URL.

```bash
BUNQUEUE_STORAGE_DRIVER=postgres \
BUNQUEUE_POSTGRES_URL='postgres://bunqueue:secret@postgres:5432/bunqueue' \
BUNQUEUE_POSTGRES_NAMESPACE=production \
BUNQUEUE_BROKER_ID=broker-a \
bunqueue start
```

**TLS.** Set both `TLS_CERT_FILE` and `TLS_KEY_FILE` or neither, setting only one is a startup error (fail fast, never silent plaintext). See the [TLS guide](/guide/tls/).

:::caution[`TCP_SOCKET_PATH` is not functional yet]
The variable is accepted and shown in the startup banner, but the TCP listener always binds `HOST:TCP_PORT` today. Use `HTTP_SOCKET_PATH` for Unix-socket access (HTTP API), or bind to `HOST=127.0.0.1` for local-only access.
:::

## Authentication & security

| Variable                      | Type        | Default | Description                                                                                                                                        |
| ----------------------------- | ----------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_TOKENS`                 | string      | (none)  | Comma-separated non-empty tokens for every TCP connection and protected HTTP endpoint; health probes stay public                                   |
| `BQ_TOKEN` / `BUNQUEUE_TOKEN` | string      | (none)  | Default token for CLI client commands (avoids `--token` on every command)                                                                          |
| `METRICS_AUTH`                | boolean     | `false` | Require auth for `/prometheus` (`1`/`true`/`yes`/`on`); without `AUTH_TOKENS`, the endpoint returns 503. Another word keeps it off, with a warning |
| `METRICS_MAX_QUEUES`          | integer ≥ 0 | `100`   | Maximum queue names exposed as Prometheus label values; `0` disables per-queue series                                                              |
| `CORS_ALLOW_ORIGIN`           | string      | (none)  | Comma-separated allowed CORS origins for the HTTP API                                                                                              |

```bash
# Server side
AUTH_TOKENS=secret-token-1,secret-token-2 bunqueue start

# Client side, every protected request must carry a token
bunqueue push emails '{"to":"test@example.com"}' --token secret-token-1
curl -H "Authorization: Bearer secret-token-1" http://localhost:6790/queues

# Or set it once for the CLI (priority: --token flag > BQ_TOKEN > BUNQUEUE_TOKEN)
export BQ_TOKEN=secret-token-1
bunqueue stats
```

`AUTH_TOKENS` is split on commas and each entry is trimmed, so `a, b` means the
tokens `a` and `b` (a client may send the token with surrounding whitespace, such
as a secret file's trailing newline). Empty entries from stray or trailing commas are ignored. An
unset or empty variable disables authentication, but a value with no token at all
(`,` or a few spaces) stops startup with
`Invalid AUTH_TOKENS: "," (expected a comma-separated list of non-empty tokens)`
instead of silently turning authentication off. The `bunqueue start --auth-tokens`
flag follows the same rule, and its errors name the flag. The server never accepts
an empty token, so a request without credentials can't match one.

The JSON `/metrics` endpoint is already covered by the general `AUTH_TOKENS`
check; `METRICS_AUTH` adds the same requirement to `/prometheus`. Enabling it
without configuring any token fails closed with 503.

## Logging

| Variable     | Type   | Default | Values                                                                                                  |
| ------------ | ------ | ------- | ------------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`  | string | `info`  | `debug`, `info`, `warn`, `error` (any case; aliases `warning`, `trace`, `verbose`, `fatal`, `critical`) |
| `LOG_FORMAT` | string | `text`  | `text`, `json` (any case)                                                                               |

An unknown value is logged as a warning and ignored. The config-file equivalents are `logging.level` and `logging.format`, which win over the env; with the Docker image, `LOG_FORMAT=json` keeps JSON output even when the file says `text`.

```bash
LOG_LEVEL=debug LOG_FORMAT=json bunqueue start
```

JSON output looks like:

```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "level": "info",
  "component": "Server",
  "message": "Received SIGTERM, shutting down..."
}
```

Structured fields appear nested under a `data` key; the startup banner itself
is plain text, not a JSON record.

## S3 backup

Automatic snapshots of the SQLite database to any S3-compatible storage. Full guide: [S3 Backup](/guide/backup/).

| Variable                  | Type    | Default          | Description                                                   |
| ------------------------- | ------- | ---------------- | ------------------------------------------------------------- |
| `S3_BACKUP_ENABLED`       | boolean | `false`          | Enable automated backups (`1` / `true` / `yes` / `on`)        |
| `S3_BUCKET`               | string  | (none)           | Bucket name (alias: `AWS_BUCKET`)                             |
| `S3_ACCESS_KEY_ID`        | string  | (none)           | Access key (alias: `AWS_ACCESS_KEY_ID`)                       |
| `S3_SECRET_ACCESS_KEY`    | string  | (none)           | Secret key (alias: `AWS_SECRET_ACCESS_KEY`)                   |
| `S3_SESSION_TOKEN`        | string  | (none)           | Temporary credential token (alias: `AWS_SESSION_TOKEN`)       |
| `S3_REGION`               | string  | `us-east-1`      | Region (alias: `AWS_REGION`)                                  |
| `S3_ENDPOINT`             | string  | (none)           | Custom endpoint for non-AWS providers (alias: `AWS_ENDPOINT`) |
| `S3_VIRTUAL_HOSTED_STYLE` | boolean | provider default | Force bucket-in-host addressing (`1` / `true` / `yes` / `on`) |
| `S3_BACKUP_INTERVAL`      | number  | `21600000` (6h)  | Interval between backups in ms (whole number ≥ `60000`)       |
| `S3_BACKUP_RETENTION`     | number  | `7`              | Number of backups to keep (whole number ≥ `1`)                |
| `S3_BACKUP_PREFIX`        | string  | `backups/`       | Key prefix for backup files                                   |

`0` or a value without a number keeps the default interval or retention, with a warning, as in earlier releases. A backup that cannot run (backups enabled without a bucket or credentials, an interval under a minute, a negative retention) does not stop the server: it logs `S3 backup configuration invalid` with the settings to fix, at error level, and runs without backups. The invalid value is never used, so pruning never runs with it; the `bunqueue backup` command refuses it. With backups off, an invalid value is only a warning.

Backups require a persistent SQLite data path (`BUNQUEUE_DATA_PATH`,
`BQ_DATA_PATH`, `DATA_PATH`, or `SQLITE_PATH`). There is no file to snapshot in
in-memory mode, and the built-in snapshot facility does not back up PostgreSQL.
Enabling it without persistent SQLite fails server startup before binding
TCP/HTTP.

```bash
# Cloudflare R2
S3_ENDPOINT=https://abc123.r2.cloudflarestorage.com S3_BACKUP_ENABLED=1 bunqueue start

# MinIO
S3_ENDPOINT=http://localhost:9000 S3_BACKUP_ENABLED=1 bunqueue start
```

## Timeouts & limits

| Variable                     | Type   | Default            | Description                                                                                                                                                                       |
| ---------------------------- | ------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SHUTDOWN_TIMEOUT_MS`        | number | `30000`            | How long graceful shutdown waits for active jobs (whole ms ≥ 0; `0` does not wait)                                                                                                |
| `STATS_INTERVAL_MS`          | number | `300000`           | Stats logging interval (whole ms ≥ 1; values above 24.8 days are honoured)                                                                                                        |
| `WORKER_TIMEOUT_MS`          | number | `30000`            | Worker-registration freshness window (whole ms ≥ 1). Older heartbeats mark a worker stale; cleanup removes it after 3× this value. The config file's `timeouts.worker` is ignored |
| `LOCK_TIMEOUT_MS`            | number | `5000`             | Timeout for acquiring internal locks (whole ms ≥ 1; values above 24.8 days are honoured). The config file's `timeouts.lock` is ignored                                            |
| `WORKER_CLEANUP_INTERVAL_MS` | number | `60000`            | Interval for removing inactive worker registrations (whole ms ≥ 1; values above 24.8 days are honoured)                                                                           |
| `TCP_IDLE_TIMEOUT_MS`        | number | `60000`            | Slowloris guard: close a connection holding a partial frame that makes no progress in this window (whole ms). Connections without a partial frame are unaffected. `0` disables    |
| `TCP_MAX_WRITE_QUEUE_BYTES`  | number | `67108864` (64 MB) | Max bytes buffered per connection's outbound queue before it is dropped (protects against clients that stop reading). Whole bytes; `0` disables                                   |

The worker, lock and TCP variables in this table accept whole numbers (an empty value keeps the default; `5000ms` is accepted). A misread value, such as `1e12`, `60s` or `64MB` for a byte count, stops the server at startup, before it prints the banner or opens a port, and the first embedded `Queue`/`Worker` for the worker and lock variables, with `Invalid NAME: "value" (expected ...)`. `TCP_IDLE_TIMEOUT_MS` and `TCP_MAX_WRITE_QUEUE_BYTES` set to `-1` or a value without a number disable the limit, as in earlier releases, with a warning.

## Webhooks

| Variable                 | Type   | Default | Description                                                                                                       |
| ------------------------ | ------ | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `WEBHOOK_MAX_RETRIES`    | number | `3`     | Delivery attempts per event, the first try included (whole number ≥ 1)                                            |
| `WEBHOOK_RETRY_DELAY_MS` | number | `1000`  | Base delay between attempts: attempt n + 1 waits `n ×` this (whole ms ≥ 0; `abc` or `-1` means 0, with a warning) |

The config file's `webhooks.maxRetries` and `webhooks.retryDelay` are ignored (they never took effect; the server logs a warning). The variables are also read by embedded mode, where an invalid value makes the `Queue`/`Worker` constructor throw.

## Server rate limiting

Protects the server itself from misbehaving clients (per TCP connection or HTTP client IP). Unrelated to per-queue job rate limiting, which is set via the [Queue API](/guide/rate-limiting/).

| Variable                  | Type                 | Default | Description                                                                                                                  |
| ------------------------- | -------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_MAX_REQUESTS` | positive integer     | `10000` | Max requests per client within the window; a value without a number disables rate limiting, with a warning (`0` is an error) |
| `RATE_LIMIT_WINDOW_MS`    | non-negative integer | `60000` | Window duration in ms; `0` disables rate limiting                                                                            |
| `RATE_LIMIT_CLEANUP_MS`   | positive integer     | `60000` | Interval in ms for evicting idle clients' tracking data; `0` or no number keeps the default, with a warning                  |

An invalid value (for example `0`, `1e4` or `1m`) fails server startup with `Invalid NAME: "value" (expected ...)`, printed as one `Fatal error:` line before the startup banner. `0` is rejected for all three: no limit, a window that never counts, or a sweep that never runs.

## Monitoring thresholds

These control the real-time monitoring events (`queue:idle`, `queue:threshold`, `worker:overloaded`, `server:memory-warning`, `storage:size-warning`) delivered over WebSocket/SSE. See the [HTTP API events reference](/api/http/#explicit-subscription-events-86).

| Variable                       | Default        | Description                                                                                 |
| ------------------------------ | -------------- | ------------------------------------------------------------------------------------------- |
| `QUEUE_IDLE_THRESHOLD_MS`      | `30000`        | Emit `queue:idle` when a queue is empty with no active jobs for this long. `0` disables     |
| `QUEUE_SIZE_THRESHOLD`         | `0` (disabled) | Emit `queue:threshold` when a queue's waiting count reaches this size                       |
| `WORKER_OVERLOAD_THRESHOLD_MS` | `30000`        | Emit `worker:overloaded` when a worker stays at max concurrency for this long. `0` disables |
| `MEMORY_WARNING_MB`            | `0` (disabled) | Emit `server:memory-warning` when heap usage exceeds this many MB                           |
| `STORAGE_WARNING_MB`           | `0` (disabled) | Emit `storage:size-warning` when the SQLite database exceeds this many MB                   |

Each threshold is a whole number ≥ 0 (`512mb` is accepted for the megabyte ones). A misread value stops the server at startup (`1e12` used to be read as 1 ms) and makes an embedded `QueueManager` throw. `-1` or a value without a number disables the alert, as it did before, now with a warning.

## bunqueue Cloud

Telemetry agent for the bunqueue Cloud dashboard. Cloud mode activates only when `BUNQUEUE_CLOUD_URL`, `BUNQUEUE_CLOUD_API_KEY`, **and** `BUNQUEUE_CLOUD_INSTANCE_ID` are all set. With Cloud mode on, an invalid numeric variable below stops startup (server and `bunqueue-mcp`); with Cloud mode off it is only a warning. An unknown word for a switch keeps it on, with a warning.

| Variable                                   | Default  | Description                                                                                                         |
| ------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `BUNQUEUE_CLOUD_URL`                       | (none)   | Cloud dashboard URL. Required for cloud mode                                                                        |
| `BUNQUEUE_CLOUD_API_KEY`                   | (none)   | API key. Required for cloud mode                                                                                    |
| `BUNQUEUE_CLOUD_INSTANCE_ID`               | (none)   | Unique instance identifier. Required for cloud mode                                                                 |
| `BUNQUEUE_CLOUD_INSTANCE_NAME`             | hostname | Display name for this instance                                                                                      |
| `BUNQUEUE_CLOUD_SIGNING_SECRET`            | (none)   | HMAC signing secret for payloads                                                                                    |
| `BUNQUEUE_CLOUD_INTERVAL_MS`               | `15000`  | Reserved: not applied (an invalid value is only a warning). Uploads use an adaptive 5–30 s cadence by snapshot size |
| `BUNQUEUE_CLOUD_INCLUDE_JOB_DATA`          | `true`   | Include job payloads in telemetry. Set `false` (or `0`/`no`/`off`) for metadata only                                |
| `BUNQUEUE_CLOUD_REDACT_FIELDS`             | (none)   | Comma-separated payload fields to redact                                                                            |
| `BUNQUEUE_CLOUD_EVENTS`                    | (all)    | Comma-separated event filter                                                                                        |
| `BUNQUEUE_CLOUD_BUFFER_SIZE`               | `720`    | Snapshot buffer size while offline (whole number ≥ 1)                                                               |
| `BUNQUEUE_CLOUD_CIRCUIT_BREAKER_THRESHOLD` | `5`      | Consecutive failures before the circuit breaker opens (≥ 1)                                                         |
| `BUNQUEUE_CLOUD_CIRCUIT_BREAKER_RESET_MS`  | `60000`  | Circuit breaker reset window in ms (whole number ≥ 1)                                                               |
| `BUNQUEUE_CLOUD_USE_WEBSOCKET`             | `true`   | Stream via WebSocket. Set `false` (or `0`/`no`/`off`) to disable                                                    |
| `BUNQUEUE_CLOUD_USE_HTTP`                  | `true`   | Upload via HTTP. Set `false` (or `0`/`no`/`off`) to disable                                                         |
| `BUNQUEUE_CLOUD_REMOTE_COMMANDS`           | `true`   | Allow remote commands from the dashboard. Set `false` (or `0`/`no`/`off`) to disable                                |

## Client & CLI

| Variable             | Type   | Default     | Description                                                                                                                                                                                                                    |
| -------------------- | ------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BUNQUEUE_MODE`      | string | `embedded`  | Connection mode for the MCP server (`embedded` or `tcp`)                                                                                                                                                                       |
| `BUNQUEUE_HOST`      | string | `localhost` | Server host for the MCP server in TCP mode; also a CLI fallback for `--host`                                                                                                                                                   |
| `BUNQUEUE_PORT`      | number | `6789`      | Server port for the MCP server in TCP mode: an integer from 1 to 65535 (`6789.0` accepted); anything else stops startup with an error naming the variable                                                                      |
| `BUNQUEUE_POOL_SIZE` | number | `2`         | Connection pool size for the MCP server in TCP mode, read with `Number()` (`1e1` is 10). A value that is not a whole number ≥ 1 (`abc`, `0`, `Infinity`) means 2, with a warning on stderr; above the pool ceiling is an error |
| `BUNQUEUE_EMBEDDED`  | string | (none)      | Set to `1` to make embedded mode the client default; `embedded: false` wins                                                                                                                                                    |
| `NO_COLOR`           | string | (none)      | Any non-empty value disables colored output (CLI, help, doctor, server banner)                                                                                                                                                 |
| `FORCE_COLOR`        | string | (none)      | Any non-empty value forces color, even on a pipe and over `NO_COLOR`; `0` or `false` force it off                                                                                                                              |

Color follows one rule everywhere (CLI results, `--help`, `doctor` and the server startup banner): `FORCE_COLOR` first, then `NO_COLOR` or `TERM=dumb`, otherwise color only on a TTY. A pipe, a log file or `docker logs` therefore gets plain text by default.

```bash
# Point the MCP server at a remote bunqueue instance
BUNQUEUE_MODE=tcp BUNQUEUE_HOST=your-server.com BUNQUEUE_PORT=7000 bunx --package=bunqueue bunqueue-mcp
```

The MCP server also reads `BUNQUEUE_TOKEN` for authentication.

**MCP agent features (all off by default).** These only affect the `bunqueue-mcp` binary; the [MCP Server guide](/guide/mcp/) explains each one: [HTTP transport](/guide/mcp/#serve-over-http), [toolsets](/guide/mcp/#load-only-the-tools-the-agent-needs), [confirmation](/guide/mcp/#confirm-destructive-operations), [decision models](/guide/mcp/#decision-models-jev-clef-clef-flash-kev-9b-laya) and [workflow approvals](/guide/mcp/#workflow-approvals).

| Variable                            | Type   | Default                     | Description                                                                                                       |
| ----------------------------------- | ------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `BUNQUEUE_MCP_TRANSPORT`            | string | `stdio`                     | `stdio`, or `http` to serve MCP Streamable HTTP to several clients                                                |
| `BUNQUEUE_MCP_HTTP_HOST`            | string | `127.0.0.1`                 | Interface to bind in http mode; a non-loopback address requires `BUNQUEUE_MCP_HTTP_TOKEN`                         |
| `BUNQUEUE_MCP_HTTP_PORT`            | number | `6791`                      | Port in http mode; `0` picks a free port                                                                          |
| `BUNQUEUE_MCP_HTTP_PATH`            | string | `/mcp`                      | Endpoint path (exact match)                                                                                       |
| `BUNQUEUE_MCP_HTTP_TOKEN`           | string | (none)                      | Comma-separated bearer tokens; required on a non-loopback host                                                    |
| `BUNQUEUE_MCP_HTTP_MAX_SESSIONS`    | number | `100`                       | Concurrent HTTP sessions; beyond it new clients get 503                                                           |
| `BUNQUEUE_MCP_HTTP_SESSION_TTL_MS`  | number | `1800000`                   | Idle time before an HTTP session is closed (never while a tool call runs)                                         |
| `BUNQUEUE_MCP_HTTP_ALLOWED_HOSTS`   | string | (none)                      | Extra accepted `Host` values: `name` (any port) or `name:port`, e.g. the name a reverse proxy uses                |
| `BUNQUEUE_MCP_HTTP_ALLOWED_ORIGINS` | string | (none)                      | Extra accepted `Origin` values, such as `https://app.example.com`                                                 |
| `BUNQUEUE_MCP_TOOLSETS`             | string | (all tools)                 | `all`, a comma list of toolsets (`queues,dlq`), or `dynamic` optionally followed by toolsets                      |
| `BUNQUEUE_MCP_CONFIRM`              | string | (off)                       | `destructive` annotates every tool and requires confirmation for the nine guarded tools (ten with workflow tools) |
| `BUNQUEUE_MCP_DECISION_PROVIDER`    | string | (none)                      | `typesafe` (Jev), `cloudflare` (Clef, Clef-flash) or `systemone` (any compatible endpoint)                        |
| `BUNQUEUE_MCP_DECISION_MODEL`       | string | `jev-latest` / `clef-flash` | Model id; required for `systemone` (for example `kev-9b` or `laya`)                                               |
| `BUNQUEUE_MCP_DECISION_API_KEY`     | string | (none)                      | Bearer token; required for `typesafe` and `cloudflare`                                                            |
| `BUNQUEUE_MCP_DECISION_ACCOUNT_ID`  | string | (none)                      | Cloudflare account id for the `cloudflare` provider                                                               |
| `BUNQUEUE_MCP_DECISION_URL`         | string | provider default            | Endpoint; required for `systemone`                                                                                |
| `BUNQUEUE_MCP_DECISION_TIMEOUT_MS`  | number | `10000`                     | Request timeout; one retry on network errors, 429 and overload                                                    |
| `BUNQUEUE_MCP_DECISION_THRESHOLD`   | number | `0.8`                       | Minimum probability that the user's request asks for a destructive operation                                      |
| `BUNQUEUE_MCP_WORKFLOW_DB`          | string | (none)                      | The workflow Engine's existing `dataPath` file; enables the three workflow tools                                  |
| `BUNQUEUE_MCP_WORKFLOW_QUEUE`       | string | `__wf:steps`                | The Engine's `queueName`; read only with `BUNQUEUE_MCP_WORKFLOW_DB`                                               |

The `BUNQUEUE_MCP_HTTP_*` variables are read only when `BUNQUEUE_MCP_TRANSPORT=http`.

**CLI port fallback.** When `--port` is not passed (or is passed empty, `--port=`), the CLI reads the first of `TCP_PORT`, `BUNQUEUE_TCP_PORT`, `BQ_TCP_PORT` that is set; an empty `TCP_PORT` means 6789. A value that is not a port (from 1 to 65535) prints a warning naming the variable and uses 6789, as in earlier releases: Kubernetes sets `BUNQUEUE_TCP_PORT=tcp://<ip>:<port>` for a Service named `bunqueue-tcp`, and that must not break the CLI. An explicit `--port` must be valid. Using `TCP_PORT` means the same variable that binds the server also routes the client in the same shell:

```bash
export TCP_PORT=7000
bunqueue stats   # connects to localhost:7000
```

**CLI host fallback.** When `--host` is not passed: `HOST` > `BUNQUEUE_HOST` > `BQ_HOST`.

## Complete examples

### Development

```bash
# .env.development
TCP_PORT=6789
HTTP_PORT=6790
BUNQUEUE_DATA_PATH=./data/dev.db
LOG_LEVEL=debug
LOG_FORMAT=text
```

### Production

```bash
# .env.production
TCP_PORT=6789
HTTP_PORT=6790
BUNQUEUE_DATA_PATH=/var/lib/production.db
LOG_LEVEL=info
LOG_FORMAT=json
AUTH_TOKENS=prod-token-abc123,prod-token-xyz789

# S3 Backup
S3_BACKUP_ENABLED=1
S3_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
S3_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
S3_BUCKET=company-bunqueue-backups
S3_REGION=us-east-1
S3_BACKUP_INTERVAL=3600000
S3_BACKUP_RETENTION=30
S3_BACKUP_PREFIX=production/
```

### Docker Compose

```yaml
services:
  bunqueue:
    image: egeominotti/bunqueue:2.9.12
    ports:
      - '6789:6789'
      - '6790:6790'
    volumes:
      - bunqueue-data:/app/data
    environment:
      - BUNQUEUE_DATA_PATH=/app/data/queue.db
      - LOG_FORMAT=json
      - AUTH_TOKENS=${AUTH_TOKENS}
      - S3_BACKUP_ENABLED=1
      - S3_ACCESS_KEY_ID=${S3_ACCESS_KEY_ID}
      - S3_SECRET_ACCESS_KEY=${S3_SECRET_ACCESS_KEY}
      - S3_BUCKET=${S3_BUCKET}
      - S3_REGION=${S3_REGION}

volumes:
  bunqueue-data:
```

Kubernetes manifests and more deployment recipes are in the [deployment guide](/guide/deployment/).

## Precedence

When the same setting comes from several sources:

1. Command-line arguments (highest)
2. Configuration file
3. Environment variables
4. Default values (lowest)

```bash
# Command-line wins
TCP_PORT=6789 bunqueue start --tcp-port 7000
# Uses port 7000
```
