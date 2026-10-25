---
title: "bunqueue v2.9.11"
description: "Fixes 23 bugs. Bun and Node.js run a timer whose delay is NaN, negative, infinite or above 2^31 - 1 ms (about 24.8 days) after about 1 ms, and an interval with such a period, or with 0, about 870 times a second."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-9-11.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-10-05"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.9.11</em></h1>
  <p class="bq-hero-sub">Fixes 23 bugs. Bun and Node.js run a timer whose delay is NaN, negative, infinite or above 2^31 - 1 ms (about 24.8 days) after about 1 ms, and an interval with such a period, or with 0, about 870 times a second.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

Bun and Node.js run a timer whose delay is `NaN`, negative, infinite or above
2^31 - 1 ms (about 24.8 days) after about 1 ms, and an interval with such a
period, or with 0, about 870 times a second. Durations and counts reached
timers, leases and storage from env vars, the config file, CLI flags, client
options, job data and protocol commands without checks, so a typo or an
unusual value could become a hot loop, a spurious timeout, a stuck job or, in
two cases, lost data. Every timer is now armed through shared helpers
(`src/shared/timers.ts`) that honour any duration and never spin, and every
value is checked where it enters under one rule:

- a value 2.9.10 handled as you meant keeps working, with the same result;
- a value 2.9.10 silently ignored or replaced with a default keeps that
  effect, and now logs a warning naming the setting;
- only a value 2.9.10 misread, or could not run without a hot loop, a ~1 ms
  timer, a stuck job or lost data, is refused: at startup with one line
  naming the setting, or with an error naming the class and option.

Upgrading from 2.9.10 changes nothing for a deployment that works today,
except the cases listed under Upgrade notes below.

#### To install bunqueue v2.9.11

```bash title="bun"
bun add bunqueue@2.9.11
```

```bash title="npm"
npm install bunqueue@2.9.11
```

```bash title="docker"
TAG=2.9.11
docker run -p 6789:6789 -p 6790:6790 ghcr.io/egeominotti/bunqueue:$TAG
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Upgrade notes

Check these before upgrading from 2.9.10; everything else behaves as before.

- **Server settings that now stop startup**, because 2.9.10 misread them or
  could not run with them:
  - a numeric env var or flag `parseInt` misread: `30s`, `5m`, `1e3`,
    `6789abc` (write `30000`; settings 2.9.10 read with `Number()`, such as
    `BUNQUEUE_POOL_SIZE` and `--max-completed-jobs`, still accept `1e3`);
  - `NaN`, empty or out-of-range ports in the config file;
  - `STATS_INTERVAL_MS=0`, `SHUTDOWN_TIMEOUT_MS` of `-1` or a non-number,
    `LOCK_TIMEOUT_MS`, `WORKER_TIMEOUT_MS` or `WORKER_CLEANUP_INTERVAL_MS` of
    0 (and `WORKER_TIMEOUT_MS=abc`), `WEBHOOK_MAX_RETRIES=0`,
    `RATE_LIMIT_MAX_REQUESTS` of 0 or less;
  - a blank auth token, a string `auth.tokens`, `--auth-tokens ""`,
    `--data-path ""`, an empty `--tls-cert=` or `--tls-key=`;
  - a config file that exports a function or an array;
  - an invalid Cloud number when Cloud is configured;
  - in embedded mode, the first `Queue` or `Worker` throws for the same
    `LOCK_TIMEOUT_MS`, `WORKER_*` and `WEBHOOK_*` values.
- **Switches that now take effect.** 2.9.10 understood only `true` for
  `METRICS_AUTH` and `S3_VIRTUAL_HOSTED_STYLE`, and only `true` or `1` for
  `S3_BACKUP_ENABLED`; `1`, `yes`, `on` or `TRUE` now mean on (with
  `METRICS_AUTH` on, a Prometheus scraper needs a token). The
  `BUNQUEUE_CLOUD_REMOTE_COMMANDS`, `_INCLUDE_JOB_DATA`, `_USE_WEBSOCKET` and
  `_USE_HTTP` switches set to `0`, `no`, `off` or `FALSE` used to mean on and
  now mean off.
- **Logging:** `LOG_FORMAT=JSON` or `LOG_LEVEL=DEBUG` in capitals now apply,
  and `LOG_LEVEL=warning`, `trace`, `verbose`, `fatal` or `critical` now set
  the matching level (2.9.10 ignored all of them and logged at `info`).
- **`--tcp-port 0`** binds an OS-assigned port (2.9.10 fell back to 6789), and
  **`bunqueue backup`** now uses the bucket and database path of the config
  file in the working directory, like the server.
- **Client values that now throw**, because 2.9.10 never processed a job,
  looped, hung or lost the lease with them: Worker `concurrency` of 0 or less
  or `NaN` (often `Number(process.env.X)` with the variable unset),
  `batchSize: 0`, a `lockDuration` of 0 or less, `NaN` or infinite while locks
  are on, `drainDelay: 0` without a long poll, a heartbeat interval below
  1 ms or infinite; connection `host: ''`, a `connectTimeout`,
  `commandTimeout`, `reconnectDelay` or `maxReconnectDelay` of 0,
  `maxPingFailures` of 0 or less, `poolSize` above 65535; Simple Mode
  `priorityAging.interval` below 1 ms.
- **Client values whose meaning changed:** `autoBatch.enabled: 'false'` or
  `0` now turns batching off, and `worker.rateLimit('1000')` now applies.
- **A permanent pull refusal is now reported**: a Worker with an `error`
  listener receives an `error` event (`context: 'pull'`), and one without a
  listener logs a line at most once a minute. 2.9.10 stayed silent.
- **Connections:** callers whose timeouts or ping settings differ open
  separate pools, so a process can open more connections.

## Changes

- **Values that 2.9.10 silently ignored or replaced now log a warning** and
  keep the same effect. Among them:
  - `-1` or a non-number TCP idle timeout, TCP write-queue cap or monitoring
    threshold (disabled), and an invalid completed-job retention (off);
  - an invalid `METRICS_MAX_QUEUES`, `*_MAX_COMPLETED_JOBS`, PostgreSQL
    count or session timeout, and `S3_BACKUP_INTERVAL`/`S3_BACKUP_RETENTION`
    of `0` or a non-number (the default);
  - `RATE_LIMIT_MAX_REQUESTS=abc` (no rate limit) and
    `WEBHOOK_RETRY_DELAY_MS` of `abc` or `-1` (immediate retries);
  - settings of a feature that is off: PostgreSQL settings on SQLite or in
    memory, Cloud numbers without Cloud, S3 settings with backups off, and
    `BUNQUEUE_CLOUD_INTERVAL_MS`, which is unused (the upload cadence adapts
    to the snapshot size, 5 to 30 s);
  - an S3 backup that cannot run (missing bucket or credentials, an interval
    under a minute, an invalid retention): still logged at error level as
    `S3 backup configuration invalid`, now naming each setting;
  - an unknown log level or format word;
  - a string for a boolean key in the config file, which is still read by
    JavaScript truthiness (`backup.enabled: 'false'` keeps backups on): use
    `true` or `false`;
  - metrics auth on with no auth token configured (`/prometheus` answers
    503, as before);
  - `timeouts.worker`, `timeouts.lock` and `webhooks.*` in the config file,
    which stay ignored as documented: set `WORKER_TIMEOUT_MS`,
    `LOCK_TIMEOUT_MS` and `WEBHOOK_*` instead;
  - in the CLI client, an env port that is not a port (Kubernetes injects
    `BUNQUEUE_TCP_PORT=tcp://10.96.0.12:6789` for a Service named
    `bunqueue-tcp`), which uses 6789;
  - in the config file, an `undefined`, `null` or empty `cors.origins` entry
    (dropped), and keys the file does not know.
- **The config file accepts what env vars accept.** Numeric strings
  (`tcpPort: process.env.PORT`), `null` as "unset" for a key or a whole
  section, and a comma-separated `cors.origins` string. `NaN`, `''` and
  out-of-range ports stop startup with an error naming the key.
- **`bunqueue start`:** `--tcp-port 0` and `--http-port 0` bind an
  OS-assigned port, an empty flag value (`--tcp-port=`, `--host=`,
  `--config=`) means the flag was not given, and `bunqueue backup` reads the
  same config file as the server.
- **Logs:** `LOG_LEVEL` and `LOG_FORMAT` are case-insensitive, `LOG_LEVEL`
  accepts the aliases `warning` (warn), `trace` and `verbose` (debug), `fatal`
  and `critical` (error), `NO_COLOR`
  accepts any non-empty value, `FORCE_COLOR` is supported, and output piped to
  a file or `docker logs` has no color codes.
- **Client options are checked at construction** (`Queue`, `Worker`,
  `SandboxedWorker`, `Bunqueue`, `ConnectionOptions`, `TcpConnectionPool`,
  `QueueManager`). A numeric string is its number, a fraction rounds as
  2.9.10's comparisons did (`concurrency: 2.5` runs 3), a negative or `NaN`
  interval that 2.9.10 guarded with `> 0` means disabled, and an option the
  active mode does not use is not checked, and no `autoBatch` value throws
  (an invalid `maxDelayMs` flushes at once, as 2.9.10's timer did). Only
  values 2.9.10 could not run throw, with an error naming the class and
  option, for example
  `Worker: heartbeatInterval must be a finite number of milliseconds >= 1 (got 0.5)`.
- **One job-options validator for every entry point** (embedded `add` and
  `addBulk`, TCP PUSH and PUSHB, flows, job-scheduler and cron templates, MCP,
  Cloud). It refuses only what no job can run with: a non-number, `NaN` or
  infinite value, a negative `timeout` or `ttl`, and a `timestamp` outside
  the date range. Errors name the option you passed
  (`attempts`, `deduplication.ttl`), and `addBulk` admits nothing when one job
  is invalid, reporting `jobs[i]: …`.
  - `attempts` of 0 or less runs the job once in every mode (TCP used to
    refuse it), and `attempts: Infinity` retries up to 2,147,483,647 times.
  - A negative `delay` keeps its past run time in every mode, as in 2.9.10
    embedded mode: the job is ready at once and runs ahead of later ready
    jobs. TCP, HTTP and MCP used to refuse it. `changeDelay` with a negative
    delay does the same (PostgreSQL makes the job ready now, as in 2.9.10),
    and `moveToDelayed(timestamp)` with a past timestamp still means "now".
  - Durations above about 136,900 years are clamped instead of overflowing.
- **`job.updateProgress()` never fails the job.** A numeric string, `true` or
  `null` is stored as 50, 1 or 0, as in 2.9.10; any other text is stored as 0
  with the text as the message (2.9.10 stored `NaN`). The `progress` event
  still carries the value you passed.
- **`changePriority` without a priority** uses 0 (BullMQ's default) instead of
  failing in embedded mode on a `NOT NULL` constraint.
- **TCP clients now read the replies to `changePriority`, `clearLogs` and
  `extendLock`**, which used to be ignored, so a refusal is reported.
- **Connections:** callers whose timeouts or ping settings differ no longer
  share a pool.
- **`RATE_LIMIT_CLEANUP_MS` of 0, negative or a non-number** now sweeps the
  rate limiter every 60 s, with a warning. With 0 or a non-number 2.9.10 never
  swept it, so entries for past clients accumulated; with a negative value it
  swept about every millisecond.
- **PostgreSQL:** expired leases are scanned at least every 15 s, and a job
  `timeout` of 0 means no timeout.
- **Invalid persisted cron templates log one warning at load** and keep their
  stored values, so they never block startup.

## SDKs

- **`bunqueue-client` 0.2.3** (TypeScript SDK; details in
  `sdk/typescript/CHANGELOG.md`) ships these client fixes, the security fix
  for shared pools and the 2.9.10 wait fix. Its legacy entry
  (`bunqueue-client/legacy`) arms every timer through the same helpers and
  keeps every 0.2.2 option result that was not broken: numeric strings, a
  negative `maxInFlight` (unbounded), fractional pool sizes, Simple Mode
  `maxAttempts: 0`, `threshold: 0` and `batch.size: 0`, unknown retry
  strategies (a fixed delay). Only values that caused a hot loop, a hang, a
  crash or a ~1 ms timer now throw.
- **Python, Go, Rust, PHP and Elixir SDKs** follow the same rule: each keeps
  every value its previous release handled as meant. The fixes are listed
  under `Unreleased` in each SDK's changelog.
  - A worker with poll timeout 0 re-polled an empty queue about 10,000 times
    a second until the broker's rate limiter cut it off. Every SDK now pauses
    after an empty pull: 50 ms, or 10 ms after a long poll.
  - The Python Worker stopped on a rate limit, a lock timeout or an internal
    error. These are now retried on its existing 0.5 to 5 s schedule; a
    permanent refusal (a bad token) still ends `run()` with the error unless
    an `error` listener is attached. Its reconnect backoff no longer overflows
    after about 85 minutes of outage.
  - Elixir no longer turns a float or `nil` `lock_ttl` into a 1 ms lease
    (`nil` means 30 s, a float rounds up), and `stop/1` no longer hangs after
    a linked crash.
  - A tiny Go heartbeat interval panicked, and PHP turned a `NaN` command
    timeout into a busy-spinning read.

## Security

- **A string `auth.tokens` in the config file made every character a token.**
  `auth: { tokens: 'secret' }` became `new Set('secret')`, so `s`, `e`, `c`,
  `r` and `t` each authenticated. A string is now refused at startup.
- **Clients with different auth tokens could share one connection.** Shared
  TCP pools were keyed by a 16-bit token fingerprint (in practice under 2,000
  distinct values), so within one process a caller with a wrong or revoked
  token could reuse another caller's authenticated connection. Pools and
  shared clients are now keyed by every connection option and the full 64-bit
  token hash.
- **`BUNQUEUE_CLOUD_REMOTE_COMMANDS=0` left remote commands on, and
  `METRICS_AUTH=1` left `/prometheus` unauthenticated.** Only the literal
  words `true`/`false` were understood. Boolean env vars now accept `1/0`,
  `true/false`, `yes/no` and `on/off` in any case. Any other word keeps the
  value 2.9.10 gave it and logs a warning.
- **An empty auth token authenticated every unauthenticated HTTP request.**
  `auth: { tokens: [process.env.API_TOKEN ?? ''] }` with the variable unset
  type-checks, and a request without an `Authorization` header matched the
  empty token; over TCP, `Auth` with an empty or whitespace token succeeded.
  `AUTH_TOKENS=,` and `--auth-tokens ,` silently turned auth off, and
  `--auth-tokens ,` overrode `AUTH_TOKENS`. A blank token in the config file,
  `AUTH_TOKENS` or `--auth-tokens` now stops startup with an error naming it
  (`auth.tokens[0] must be a non-empty string (got undefined)`), and the
  HTTP, TCP and WebSocket checks never accept a blank token. Configured and
  presented tokens are both compared trimmed, so a token read from a secret
  file with a trailing newline keeps working on both sides.

## Bugfixes

**Data loss**

- **An invalid S3 backup retention deleted every backup.** A `NaN` retention
  from the config file passed validation and the prune deleted all backups,
  the one just uploaded included. A backup whose settings are invalid now
  logs `S3 backup configuration invalid`, naming each setting, and never runs
  or prunes; the server keeps running, as it did.
- **`BUNQUEUE_COMPLETED_RETENTION_MS=1e12` deleted completed jobs at once.**
  `parseInt` read it as 1 ms. A numeric env var or flag that `parseInt`
  misread (`1e12`, `30s`, `6789abc`) now stops startup with an error naming
  it. Every form it read as meant keeps working: `+6789`, a decimal fraction
  (truncated, as `parseInt` did: `1500.5` is 1500), the setting's own unit
  (`5000ms`, `512mb`) and a trailing `# comment`.

**Jobs stuck, lost or out of order**

- **A job `timeout` of 0, `NaN` or above 24.8 days failed every job.** The
  Worker aborted the processor after about 1 ms and dropped the outcome, while
  the broker treated the job as having no timeout. The job sat `active` until
  stall or lease recovery redelivered it, ran its processor once per attempt
  and ended in the DLQ; on PostgreSQL every run lost its lease at once. 0 is a
  valid value over TCP. The broker, the Worker and PostgreSQL now share one rule
  (`src/domain/job/timeoutRule.ts`): 0 and `NaN` mean no timeout, long
  timeouts are honoured, and fractional timeouts, which the broker never
  enforced, are rounded up.
- **A `NaN` delay, backoff or timestamp broke the job.** It stayed delayed
  forever or was silently dropped by the write buffer (`NOT NULL`), a grouped
  job with a `NaN` delay froze the process, and every long-poll pull on the
  queue re-armed a timer about 870 times a second. These values are refused
  where they enter, and the engine treats a non-finite run time as due.
- **A numeric string option broke the job.** `delay: '1000'` was appended to
  a timestamp as text and scheduled the job hundreds of thousands of years
  ahead, and `timeout: '50'` left the job `active`. Plain decimal strings are now read as
  numbers in every mode, so `attempts: '3'`, `priority: '5'` and
  `backoff: '200'` keep working and the broken cases do what they say.
- **A `backoff` object without `delay` lost the job.** In embedded mode the
  write buffer dropped it (`NOT NULL constraint failed: jobs.backoff`) and it
  stayed `waiting` after its first failure; flows threw the SQL error and TCP
  returned `Internal server error`. It now uses the default 1000 ms base, in
  every mode and in job-scheduler templates.
- **PostgreSQL: one stored fractional `timeout` or `stallTimeout` blocked the
  whole queue.** Every claim of the queue head failed with
  `invalid input syntax for type bigint`. Leases are now always whole
  milliseconds within the valid date range.
- **PostgreSQL: a priority outside the 32-bit range failed the insert.** The
  column now holds the clamped value; the job keeps its exact priority.
- **SandboxedWorker: jobs were sent to crashed threads.** A thread that exited
  kept receiving jobs once restarts were off or used up, and with `timeout: 0`
  those jobs hung. A crash now fails the running job at once (retried per its
  attempts), a thread past `maxRestarts` is retired, and when none is left the
  worker stops with an `error` whose context is `exhausted`.
- **SandboxedWorker: a restarted thread lost jobs while its processor
  loaded.** The thread installed its message handler only after importing the
  processor, and the pool dispatched to it at once, so a job sent during a
  slow import was dropped and stayed `active` (or timed out and used up a
  restart). A thread now receives jobs only after its processor has loaded,
  a processor that fails to load counts as a crash, and `stop()` during a
  restart terminates the loading thread.
- **PostgreSQL: a wait on a job removed on completion reported "not found".**
  Without `QueueEvents`, a wait whose first state read ran after the removal
  missed the result the broker still held. It now asks the broker before
  settling.
- **A non-boolean `lifo` (for example `1`) reversed the order of jobs.** It is
  now stored as a boolean, on add and on `changePriority`.
- **Over TCP, `job.clearLogs(n)` cleared every log entry.** The client dropped
  `n`; it now keeps the last `n` entries, as embedded mode did.

**Hot loops, floods and crashes**

- **Every timer that takes a configurable or computed delay honours long
  durations and never spins.** This covers:
  - the Worker heartbeats, pull loop, `drainDelay`, rate-limit waits and
    `delay()`;
  - the TCP client ping, reconnect backoff, connect timeout and per-command
    timeout;
  - the SandboxedWorker job timeout, idle watch, heartbeat and pull wait;
  - Simple Mode priority aging, batch timeout, `cancel()` grace period,
    circuit-breaker reset and retry backoff (which overflowed from attempt
    22 on);
  - the server stats log, worker cleanup, rate-limiter cleanup, S3 backup
    interval, TCP idle timeout and internal lock timeout;
  - `QueueManager` background intervals and `waitForJobCompletion`;
  - PostgreSQL polling, lease, recovery and retry timers.
- **An invalid `LOCK_TIMEOUT_MS` failed every contended operation.** With
  `abc` or a value above the timer limit, every contended internal lock threw
  `LockTimeoutError` after about 4 ms, embedded mode included. A value above
  the timer limit is now honoured, and one that is not a number stops startup
  with an error naming it.
- **Cron: an entry with a `NaN` next run spun the scheduler**, saving `NaN`
  every millisecond. It is now rescheduled from now and reported as missed,
  and other crons keep firing. Workflow `waitFor` and sub-workflow steps with
  an invalid start time now fail cleanly.
- **PostgreSQL: a failed post-commit maintenance step retried back to back**
  (89 attempts in 100 ms), skipping its retry delay. Retries now wait, capped
  at 1 s, and a long poll interval no longer delays them.
- **TCP mode: a synchronous Queue method could crash the process when the
  broker was unreachable.** `pause()`, `resume()`, `drain()`, `obliterate()`,
  `remove()`, `job.discard()`, `setDlqConfig()` (also run by the `dlq`
  constructor option), `retryDlq()`, `purgeDlq()`, `retryCompleted()`,
  `setStallConfig()` and the rate-limit and concurrency setters sent their
  command without a rejection handler, so a failed send became an unhandled
  rejection and Bun ended the process. A failure is now logged as one line
  naming the command and the queue; Simple Mode emits it on its `error` event
  while a listener is attached, and a failed trigger `add` is reported the
  same way. The `...Async` variants still reject to their caller.
- **Worker: a refused pull looked like an empty queue.** A Worker or
  SandboxedWorker refused for good (a bad token, an invalid queue name, a
  rejected option) idled silently and emitted `drained`. It now backs off
  (100 ms to 30 s) and resumes once the cause is fixed. The refusal goes to
  the `error` event (`context: 'pull'`) when a listener is attached, and
  otherwise to one `console.error` line a minute naming the queue and the
  reason; it never ends the process. Transient refusals (rate limit, lock
  timeout, internal error) are re-polled on the empty-queue cadence and not
  reported, as before (`drainDelay`, 10 ms with a long poll, `pollInterval`
  for SandboxedWorker), but no longer emit `drained`, since jobs may still be
  waiting. An `error` listener that throws no longer causes an unhandled
  rejection, and `getNextJob()` still resolves `undefined` on a refusal.
- **SandboxedWorker: one pull error stopped pulling for good**, and a failed
  `start()` left a worker that reported running but pulled nothing. Pull
  errors now back off and retry, and a failed `start()` rejects and leaves
  nothing running. `stop()` is idempotent and always wins over `autoStart`,
  and `autoStart` now works in TCP mode when the worker is the pool's only
  user.
- **TCP client connection races.** `close()` during `connect()` now wins and
  closes the socket. A socket that hits the connect timeout is closed (they
  stayed open, and a late close could drop the newer connection). `close()`
  inside a `'reconnecting'` listener no longer reconnects.
- **Simple Mode:** aging ticks no longer overlap, a failed aging query no
  longer crashes the process with an unhandled rejection, a `NaN` aging boost
  is refused, and a constructor that throws no longer leaves its Queue and
  Worker running.
- **MCP: `BUNQUEUE_POOL_SIZE=Infinity` looped until the process ran out of
  memory.** `Infinity` and values above 65535 now stop the MCP server with an
  error naming the variable; other unreadable values use 2 with a warning, and
  `1e3` is still 1000.

## Documentation

- New internal references: `docs/features/shared-timers.md` (the timer limit,
  the helpers, the validation policy) and
  `docs/features/job-options-validation.md`.
- `docs/features/configuration.md` has an "Upgrade compatibility with 2.9.10"
  table.
- The env var, configuration, worker, sandboxed worker, Simple Mode, TCP
  protocol, HTTP API, PostgreSQL and backup pages document the accepted range
  of every setting and option, and what 0, negative and very large values
  mean.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.9.10](/blog/bunqueue-v2-9-10/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.9.11) · [Commits since v2.9.10](https://github.com/egeominotti/bunqueue/compare/v2.9.10...v2.9.11) · [Full changelog](/changelog/) · [All posts](/blog/)
