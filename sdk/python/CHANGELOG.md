# Changelog

All notable changes to `bunqueue-client` (Python SDK) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Compatibility: every option value that worked in 0.2.0 keeps its 0.2.0
result. That includes `None`, a bool, a numeric string where 0.2.0 read the
option with `float()`/`int()`, and a Simple Mode 0 that meant the default.
Only values that 0.2.0 could not handle now raise `TypeError` or
`ValueError` at construction, naming the option: values that crashed a
thread, never connected, failed every command or job, or spun a hot loop.

### Fixed

- A transient pull failure no longer ends the Worker loop. The loop retried
  only `ConnectionClosedError` and `CommandTimeoutError`. Broker refusals that
  pass with time escaped and shut the worker down for good: `Rate limit
  exceeded`, `Lock acquisition timed out` and its read/write variants, and
  `Internal server error`. The loop now classifies a failure as the main
  client does (`isTransientPullError`, `handlePullError` in
  `src/client/worker/runtime/polling.ts`):
  - a transient failure is emitted as `error`, logged at debug level and
    retried after 0.5, 1, 2, then 5 s, the 0.2.0 reconnect schedule. A pull
    the broker answers resets it.
  - a permanent refusal (an `AuthError` for a wrong token, a validation
    refusal, `Not authenticated`) or an unexpected exception still ends the
    loop and is raised from `run()`, as in 0.2.0, when no `error` listener is
    attached. In the main client the same unhandled `error` emit ends the
    process. With a listener (`on` or `once`) the failure is emitted and
    retried on the same schedule, so fixing a token or a broker setting
    recovers the same Worker without a restart. The `bunqueue` logger
    reports a retried refusal as a warning and an unexpected exception as an
    error with its traceback.

  `KeyboardInterrupt` and `SystemExit` still end a blocking `run()`.
- An exception that is not a `BunqueueError` no longer kills a Worker thread
  while `is_running()` keeps reporting the worker as running. An `OSError`
  raised during a lazy reconnect is one example:
  - in the first `RegisterWorker`, it ended the loop before it started, and
    `is_running()` kept reporting the dead worker as running;
  - in a heartbeat, it stopped the heartbeat thread, so active jobs lost
    their lock renewals;
  - in an `ACK` or `FAIL`, it skipped the release of the job's concurrency
    slot, so a worker with concurrency 1 stopped pulling.

  These paths now log the exception with its traceback, emit `error` and
  carry on. A failed registration is retried by the next poll, and that
  pull then follows the policy above.
- Reconnect backoff no longer overflows. After about 1,025 consecutive failed
  connects (an outage of roughly 85 minutes), `0.5 * 2 ** (n - 1)` raised
  `OverflowError` instead of `ConnectionClosedError`. That killed the Worker
  loop for good, and every later call re-dialed with no backoff. The delay now
  stays within 0.5–5 s.
- An empty pull is no longer re-issued at once. `poll_timeout_ms=0` sent
  about 10,000 `PULLB` per second, until the broker's rate limit stopped the
  worker; a 1 ms long-poll sent about 700. The loop now follows the main
  client's rule (`pollTimeout > 0 ? 10 : drainDelay`): it waits 10 ms after an
  empty long-poll and 50 ms after an empty non-blocking pull. Measured idle
  rates are now 72 per second at 1 ms and 18 at 0.
- A `lock_ttl_ms` that is NaN, infinite, below 1, a bool or a string is
  rejected by the Worker constructor. Such a value is not a usable lease: one
  below 1 ms has already expired when the broker grants it, so a job could be
  delivered again while still running, and the others never expire or are not
  numbers. `None` still sends `lockTtl: null`, and the broker leases for its
  30000 ms default.
- An infinite `heartbeat_interval_s` disables heartbeats, and one above
  `threading.TIMEOUT_MAX` is capped. Neither crashes the heartbeat thread
  with `OverflowError` any more. `None` means the 10 s default, where it used
  to kill the loop with `TypeError`. `False` still disables heartbeats and
  `True` still beats every second.
- An infinite `ack_batch.max_delay_ms` raises `ValueError`; it crashed the
  timer thread and left the ACKs buffered until the batch filled. A delay
  above `threading.TIMEOUT_MAX` is capped. Every other value is still read
  with `float()`: `"5"` is 5 ms, and a negative or NaN delay flushes at once.
- `connect_timeout` and `command_timeout` (and an explicit
  `call(timeout=...)`) must be numbers of seconds > 0. Before:
  - zero, negative and NaN command deadlines failed every command at once
    with `CommandTimeoutError`, tearing the socket down every third command;
  - an infinite command deadline raised `OverflowError` and leaked the
    pending future. `command_timeout=None` or `math.inf` now means no client
    deadline;
  - a zero, negative, NaN or infinite `connect_timeout` never connected, or
    raised `ValueError`/`OverflowError` out of the Worker loop.

  `connect_timeout=None` keeps the blocking connect of 0.2.0, with no client
  deadline. `True` still means 1 second, and a long timeout is capped at
  `threading.TIMEOUT_MAX`.
- Simple Mode rejects, before the Queue and Worker exist, the `retry`,
  `circuit_breaker`, `batch`, `priority_aging` and `rate_limit` values that
  failed later. Before:
  - a NaN or negative `priority_aging.interval` re-armed its timer at once:
    about 27,000 aging ticks per second, each running two queries. An
    infinite one crashed the Timer thread;
  - a NaN, negative or infinite `retry.delay` raised from `time.sleep`
    inside the job and masked the processor's own error;
  - an option read with `int()`/`float()` that it cannot read (NaN
    `max_attempts`, `threshold`, `boost`, `max_priority` or `max_scan`, an
    infinite one of the last three, or a non-numeric string) raised inside
    every job, failure or aging tick;
  - an infinite `batch.timeout` or `rate_limit.duration` crashed the Timer
    thread or raised from `time.sleep`, and a `rate_limit.max` below 1
    blocked every job forever;
  - a `retry_if`, a `custom_backoff` (with the `custom` strategy) or a
    `batch.processor` that is not callable failed every job.

  Every other value keeps its 0.2.0 reading, `x or default` and then
  `int()`/`float()`. A 0 still means the default. A negative
  `circuit_breaker.reset_timeout` still half-opens at once, and an unknown
  `retry.strategy` still uses the fixed delay. A missing `batch.size` or
  `rate_limit.max` still raises `KeyError`, and for `rate_limit` it now does
  so before the Worker starts. `math.inf` is accepted where it has a
  meaning:
  - `retry.max_attempts`: retry until success;
  - `circuit_breaker.threshold`: the breaker never opens;
  - `circuit_breaker.reset_timeout`: the breaker stays open until `reset()`;
  - `batch.size`: flush on timeout or close only.
- Retry backoff (`exponential`, `jitter`, `fibonacci`) saturates at 2**53 - 1
  ms instead of raising `OverflowError`; a zero base stays 0.
- A `custom_backoff` result is still read with `float()`. A result that is
  NaN, negative, infinite or unreadable used to raise from `time.sleep`; it
  now fails with an error whose `__cause__` is the processor error.
- Heartbeat interval, batch size, poll timeout and `wait_for_job` ttl follow
  `sdk/CLAUDE.md` rule 4 (protocol sections 6.3 and 9; `bunqueue/sdk_clamps.py`).
  A number never raises, and `None` means the default:
  - `heartbeat_interval_s`: see the heartbeat entry above.
  - `batch_size`: still `max(1, min(value, 1000))`. NaN still gives 1,
    infinity 1000, and a bool 1. `None` means 10, where it used to raise.
  - `poll_timeout_ms`: clamped to [0, 30000], and NaN means 5000. A NaN or
    negative value used to reach the broker, which rejected the `PULLB` and
    shut the worker down. A bool, which the broker also refused, raises
    `TypeError` at construction.
  - `wait_for_job(timeout_ms)`: still `max(0, min(value, 600000))`. NaN
    still waits 0 and `False` 0. `None` means 30000, where it used to raise,
    and `True` waits 1 ms, where the broker used to refuse it.

  Any other non-number raises `TypeError` naming the option.
- `Bunqueue.cancel()` and `CancellationManager.cancel()` raise `ValueError`
  for an infinite `grace_period_ms`: it crashed the Timer thread and never
  aborted. A grace above `threading.TIMEOUT_MAX` is capped. Any other value
  keeps its 0.2.0 meaning: above 0 waits (`True` waits 1 ms), anything else
  (0, negative, NaN, `False`) aborts at once.

## [0.2.0] - 2026-10-02

The first release after 0.1.5. It also ships every change listed under 0.1.6,
which was prepared but never published to PyPI. 0.2.0 speaks wire protocol v3
(job names travel outside `data`) and rejects flow options it used to ignore,
so upgrade together with a bunqueue server 2.8.57 or later.

### Security

- Raise the `test` extra from pytest 8.4.2 to 9.0.3, which fixes
  CVE-2025-71176 (GHSA-6w46-j5rx-g56g, insecure tmpdir handling). pytest 9
  requires Python 3.10+, so the pin carries a `python_version >= '3.10'`
  marker and the pytest-based suites now need Python 3.10+; the runtime
  package and the standalone integration/E2E runners still support 3.9.

### Fixed

- Make the `ack_batching_suppresses_only_timed_out_position` E2E test wait for
  the `completed` event, not only the broker state. The broker marks the job
  completed when it applies the ACKB, but the worker emits the event only after
  the reply returns, so a state poll landing in between failed the assertion on
  a loaded CI runner (Python 3.9). The test still asserts that only the live
  job completes.
- Wake the saturated Worker pull loop when an ACK or FAIL releases a
  concurrency slot, retaining the existing 50 ms fallback while avoiding a
  full polling delay between completion waves.
- Treat broker ACK/FAIL outcomes as authoritative after a timeout race. A
  successful `applied: false` response now suppresses false Worker terminal
  events and counters without reporting an error. Batched ACKs honor
  positional `ignoredIndices`, including duplicate job IDs, and reject
  malformed or `ignoredIds`-only evidence instead of guessing which generation
  completed. Historical ACKB responses without `data` still mean every
  position applied.
- Forward a Worker-owned Job's lease token through `retry()`, `change_delay()`,
  `move_to_delayed()`, and `discard()`, and accept the token on the matching
  Queue mutation methods. Active transitions now satisfy broker ownership
  instead of failing, silently leaving the job active, or allowing an old
  delivery to discard a newer generation.
- Negotiate wire protocol v3 and advertise the `separate-job-name`
  capability in `Hello`.
- Send `PUSH`/`PUSHB` names through top-level `name`, preserve user `data`
  without wrapping or reserving `data["name"]`, decode legacy envelopes on
  read, and send scheduler job names through `jobName`.
- Forward `duration_ms` from `set_global_rate_limit(max_jobs, duration_ms)` as
  the broker's `duration` field instead of silently using one second.

## [0.1.6] - unpublished (shipped in 0.2.0)

### Added

- Add deterministic Hypothesis campaigns for generated flow trees, shrinking,
  ID uniqueness, graph closure, reciprocal links, shape isomorphism, option
  forwarding, chain/fan-in topology, and broker snapshot validation.
- Add a mutmut gate scoped to the pure tree/legacy planners and snapshot
  validator.

### Fixed

- Compile trees, bulk trees, chains, and fan-in graphs with all IDs preallocated
  and commit them through one broker-side atomic `PUSHF` command. Partial
  `PUSH`/`UpdateParent` graphs and best-effort rollback are no longer possible.
- Map public `job_id` to the planned ID and wire `customId`, preserve explicit
  empty tags, reject repeat/deduplication/debounce and caller-owned topology,
  reject `job_id` queue defaults, and protect internal flow metadata from
  user-data overwrites.
- Reject falsy non-dictionary `opts` and `queues_options` values instead of
  silently treating malformed option containers as omitted.
- Validate the exact returned snapshot ID/queue set and construct every public
  `FlowNode` from committed broker snapshots.

## [0.1.5] - 2026-07-20

First version published on PyPI: `pip install bunqueue-client`.

### Fixed

- Reject MessagePack payloads larger than the protocol's 64 MiB frame cap
  locally with `SerializationError`, before registering a pending request or
  writing to the socket.
- Recursively validate commands before writing: cyclic containers, non-string
  map keys, and integers beyond float64 range now raise `SerializationError`
  without leaking pending requests. Shared containers remain valid; binary
  values and list/tuple arrays keep their wire representation.

### Added

- Dependency-free structured transport telemetry through the optional
  `on_telemetry` callback, with lifecycle, auth, command latency, timeout,
  reconnect, and error events. Consumer exceptions are isolated.
- Focused real-server telemetry tests. Connection lifecycle and frame helpers
  were split into single-responsibility modules below the 300-line source cap.
- Add independent-thread idempotency and single-lease races, fixed-seed
  generated payload invariants, malformed mutation fuzzing, and an opt-in
  sustained producer profile.

## [0.1.4] - 2026-07-14

Conformance-suite driven: the SDK is now certified by the cross-language
conformance kit (`sdk/conformance`, 17/17) against the formal wire spec
(`docs/protocol.md`).

### Fixed

- **`drain()` now returns the number of removed jobs** (was `None`,
  silently discarding the wire `count`).

## [0.1.3] - 2026-07-14

Spec-alignment audit against the core protocol. Every fix ships with a repro
test in `tests/e2e_spec_align.py`.

### Fixed

- **`heartbeat_interval_s=0` now disables heartbeats.** Previously
  `Event.wait(0)` made the heartbeat loop busy-spin, flooding the server with
  `Heartbeat` commands. `0` (or negative) now matches the official client's
  "0 = disabled" semantics.
- **`batch_size` is clamped to the server maximum (1000).** The server
  rejects `PULLB` with `count > 1000`; an unclamped `batch_size` combined
  with `concurrency > 1000` wedged the poll loop in a permanent error cycle.
- **FAIL stack truncation no longer loses the raise site.** The worker sent
  the last 20 traceback lines but the server persists only the FIRST
  `stackTraceLimit` lines (default 10), so long tracebacks kept a middle
  window without the raise site. The worker now sends at most as many
  trailing lines as the server keeps, honoring a per-job `stackTraceLimit`.
- **Simple Mode `cron()`/`every()` forward the execution `limit=`.** The
  option was silently dropped (the "client drops a wire-supported field"
  class, #111); it now reaches the scheduler as wire `maxLimit`.
- **`wait_for_job()` clamps `timeout_ms` to the server cap (600000).**
  Larger values were rejected by the server with "timeout must be at most
  600000" instead of waiting.
- **`PROTOCOL_VERSION` bumped to 2**, matching the version the server
  advertises in `Hello`.

## [0.1.2] - 2026-07-10

Second audit pass: packaging, connection failure paths, worker lifecycle
edges. New fixes ship with repro tests in `tests/e2e_audit_fixes.py` and
`tests/e2e_worker.py`.

### Added

- **Opt-in ACKB batching for the Worker** (TS SDK parity):
  `Worker(..., ack_batch={"max_size": 50, "max_delay_ms": 5})` buffers
  successful ACKs and flushes them as a single `ACKB` round-trip on size,
  delay, or close. A job stays active (lock renewed) until its batch settles;
  on a failed batch each job gets an `error` event and `completed` is NOT
  emitted. (H2)
- **PEP 561**: the package now ships `bunqueue/py.typed`, so type checkers
  consume the inline hints; `Typing :: Typed` classifier added. (H1)
- **Logging**: a `logging.getLogger("bunqueue")` logger (NullHandler attached
  in `__init__`) now surfaces the previously silent failure points at warning
  level: `_safe_call` swallowed errors, raising event listeners, failed worker
  registrations, priority-aging ticks, ACKB settle-callback errors. (H2)
- `Worker` is now a context manager (`with Worker(...) as w:`), matching
  `Queue` and `FlowProducer`. (M3)
- `SerializationError` (subclass of `BunqueueError`), raised when a command
  payload cannot be msgpack-serialized; the original error is chained. (M1)

### Fixed

- **Pending-future leak on serialization failure.** `Connection._send`
  registered the reqId future before `msgpack.packb`; an unserializable
  payload (e.g. a `datetime` in job data) leaked the entry forever and
  surfaced as a raw `TypeError`. Payloads now serialize first and failures
  raise `SerializationError`. (M1)
- **TLS handshake failures** now close the raw socket (no fd leak), count into
  the same reconnect backoff as plain connect failures, and raise
  `ConnectionClosedError` with the `ssl` error chained, instead of leaking a
  raw `ssl.SSLError`. (M2)
- **Worker close edges**: `close()` with `autorun=False` and `run()` never
  called now marks the worker closed and closes its connection; an expired
  `close(timeout)` returns `False` and keeps the live thread reference (state
  stays honest, a later `close()` joins again) instead of nulling it. (M3)
- **Register false-success.** A failed `RegisterWorker` no longer marks the
  generation as registered, so the next poll iteration retries; previously the
  server could stay unaware of the worker until the next reconnect
  (Discussion #103 class). (M5)
- **Scheduler template priority/deduplication** (#111 class, TS SDK parity):
  `upsert_job_scheduler` now sends the template's `priority` and
  `deduplication` (`uniqueKey`/`dedup`) as top-level `Cron` fields, where the
  server actually reads them; inside `jobOptions` they were silently ignored
  and spawned jobs fell back to defaults.
- **move_job_to_failed with an exception** (#111 class, TS SDK parity): when
  passed an `Exception`, the FAIL command now carries `stack` (bounded
  traceback lines, last-lines like the worker path) and the `unrecoverable`
  flag for `UnrecoverableError`, so the failure intent and stacktrace persist
  server-side. String errors travel unchanged.

### Verified

- Not-found narrowing: `get_job`, `get_job_by_custom_id`, `get_job_scheduler`
  and `get_flow` already catch only `CommandError` with a "not found" message
  (mapping it to `None`) and rethrow everything else; connection/timeout
  failures never masquerade as a missing job. Regression test added.

### Packaging

- `LICENSE` (MIT) now ships with the sdist/wheel; pyproject uses the SPDX
  `license = "MIT"` expression with `license-files` (hatchling >= 1.27).
- Classifiers for Python 3.9 through 3.13; `Repository` and `Changelog`
  project URLs. (M4)

## [0.1.1] - 2026-07-08

Protocol-coherence audit against the bunqueue server. Every fix ships with a
RED→GREEN repro in `tests/e2e_audit_fixes.py`.

### Fixed

- **add_bulk dropped the custom job id.** PUSHB entries are `JobInput`
  (`customId`), not the single-PUSH `jobId` the server renames — the batch
  path now renames `jobId`→`customId`, so `get_job_by_custom_id` and idempotent
  bulk ingest work. (H1)
- **Half-open link wedge.** Enable `SO_KEEPALIVE` (~15s idle) and tear down the
  socket after 3 consecutive command timeouts so the next call reconnects,
  instead of wedging until the OS abandons the writes. The teardown is
  generation-guarded so a stale-connection timeout can't abort a fresh
  reconnect. (H2)
- **Auth race on reconnect.** `_conn_lock` is now reentrant and Auth is sent
  while holding it, flipping `_connected` only after Auth completes — a
  concurrent thread can no longer send a command ahead of the Auth frame
  (server would reject it `Not authenticated`). (H3)
- **get_flow crashed on a missing job.** A missing root/child now yields `None`
  and is skipped (partial tree) instead of raising; the catch is narrowed to
  `'not found'` so real server errors still surface, and a `visited` set guards
  against cycles now that `depth` defaults to unlimited. (H4)
- **wait_for_job returned `None` on timeout.** It now raises on non-completion:
  a `failed` job raises `CommandError`, otherwise `CommandTimeoutError` — the
  `completed` flag is no longer ignored. (M1)

### Changed

- Simple Mode cron (`Bunqueue.cron`/`every`, `upsert_job_scheduler`) now maps
  Pythonic job options snake_case→camelCase via `build_cron_job_options`
  (`attempts`→`maxAttempts`, `remove_on_complete`→`removeOnComplete`, …) so
  cron-spawned jobs honor the requested retry/cleanup policy instead of falling
  back to server defaults; also forwards `skip_missed_on_restart`. (M3)
- `retry_dlq` / `retry_jobs`: the dead `count` field is no longer sent on the
  wire (the server has no partial RetryDlq; `count` is accepted only for
  signature parity).

## [0.1.0] - initial published release

- TCP client (msgpack wire protocol): `Queue`, `Worker`, `FlowProducer`,
  `Bunqueue` Simple Mode, TLS, auth, reqId pipelining.
