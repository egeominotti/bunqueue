# Changelog

All notable changes to `bunqueue/client` (PHP SDK) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Breaking: invalid timeouts and lock TTLs now throw `\InvalidArgumentException`
at construction instead of failing later.

### Fixed

- `Worker::run()` no longer re-polls at once after a pull that found no job.
  It waits as the main client does (`src/client/worker/runtime/polling.ts`):
  - 10 ms when `pollTimeoutMs > 0`. A 1 ms long-poll issued 340 `PULLB` per
    second; it now issues about 67.
  - 50 ms (the main client's default `drainDelay`) when the poll timeout is 0,
    including a negative `pollTimeoutMs`, which clamps to 0. Before, an idle
    worker issued about 10,000 `PULLB` per second until the broker's rate
    limit rejected it.
  `runOnce()` is unchanged and still returns at once.
- `connectTimeout` and `commandTimeout` (Connection, Queue, Worker,
  FlowProducer options) and the explicit `Connection::call()` timeout must
  be finite numbers of seconds above 0. Before:
  - `NAN`/`INF` turned every socket read non-blocking (`(int) NAN === 0`).
    A read busy-spun until the response arrived and never timed out.
  - `0` or a negative value timed out every command right after a fresh
    connect, so each call opened a new connection.
  - A non-finite `connectTimeout` made `stream_socket_client` throw a
    `ValueError` that escaped `Worker::run()`.
- `connectTimeout`, `commandTimeout` and an explicit `call()` timeout are capped
  at 2,147,482 s (about 24.85 days, `OptionGuard::MAX_TIMEOUT_S`). That is the
  longest stream timeout PHP honours: `php_tvtoto()` turns a longer one into an
  infinite poll. Above `PHP_INT_MAX` the `(int)` cast wrapped:
  - `1e300` became a 0 s timeout. A 504 ms long-poll burned 503 ms of CPU and
    the read never timed out.
  - `2^64 + 8192` became an early 8192 s timeout.
  Larger values are clamped, so `1e9` still means "effectively never".
- `lockTtlMs` must be a whole number of milliseconds >= 1. Before, any int
  reached the wire. A lease of 0 or less is already expired when granted, so
  a job could be delivered again while it was still running.
- A non-number timeout or `lockTtlMs` now throws `\InvalidArgumentException`.
  PHP already rejected it before, with a `TypeError` from the typed property.
- `pollTimeoutMs` values that PHP's int cast broke now clamp to [0, 30000]
  (sdk/CLAUDE.md rule 4). Before, each became a non-blocking pull or wrapped:
  - `NAN` was 0; it now means the 5000 default.
  - `INF` was 0; it now clamps to 30000.
  - A float beyond the int range wrapped: `1e19` was 0, `-1e19` was 30000
    and `2^64 + 8192` was 8192. They now clamp to 30000, 0 and 30000.
  Every other value keeps its 0.2.0 setting. An int or finite float clamps as
  before, and a numeric string such as `'5000'` from the environment is still
  honoured. Any other value still means 0. `batchSize` and
  `heartbeatIntervalS` keep their 0.2.0 conversion, and none of these options
  throws.
- `waitForJob()` takes `int|float|null`. `null` or `NAN` means 30000, and
  `INF` waits for the 600000 maximum. Before, `null` and a non-finite float
  threw PHP's own `TypeError`, as did any float in a `strict_types` file.
  Every value 0.2.0 accepted keeps its result.

## [0.2.0] - 2026-10-02

Breaking: `Job::data()` now returns `mixed` (it was `array`) and invalid options
are rejected. Requires a bunqueue server 2.8.57 or later (wire protocol v3).

### Changed

- Treat successful `ACK`/`FAIL` responses with `applied: false` as an
  authoritative broker timeout outcome. The Worker now releases the held lease
  without emitting a false `completed`/`failed` event, incrementing a counter,
  or reporting the expected no-op as an error.
- Negotiate wire protocol v3 and advertise the `separate-job-name`
  capability in `Hello`.
- Send ordinary job names through top-level `name`, preserve mixed user `data`
  values, decode legacy data envelopes, and use `jobName` for scheduler jobs.
  `Job::data()` now returns `mixed` so lists, scalars, and null remain intact.
- Compile flow trees and chains locally with preallocated portable IDs and
  commit the complete reciprocal topology through one atomic `PUSHF`.
- Validate returned snapshots against the exact requested ID and queue set;
  partial, duplicate, unknown and cross-queue responses are rejected.
- Reject reserved data markers, user-supplied topology, invalid queue names,
  and repeat/deduplication/debounce options before any broker I/O.

### Added

- Eris 1.1.0 shrinking properties for topology, wire preservation, atomicity,
  generated IDs and invalid-input no-I/O behavior on PHP 8.1–8.4.
- Infection 0.34.1 + PCOV mutation gate for the pure planner and snapshot
  validator, with a 99% MSI ratchet and machine-readable reports.
- Language-specific invariants and contributor guardrails.

## [0.1.1] - 2026-07-20

First version published on Packagist (`composer require bunqueue/client`),
distributed through the read-only mirror repository
[`egeominotti/bunqueue-php`](https://github.com/egeominotti/bunqueue-php).

### Added

- Optional payload-free connection telemetry (`onEvent`) for connection,
  reconnection, authentication, command, timeout, error and close events.
- Rate-limit duration windows and broker-side TTL forwarding.
- Add multi-process idempotency and single-lease races, generated payload
  invariants, malformed depth fuzzing, a 512-job spike, and an opt-in soak.

### Fixed

- Normalize nested MessagePack ext type 0 values to `null`.
- Reject cyclic/excessively nested values and non-string map keys before
  recursive traversal, then wrap serialization failures in the SDK exception
  hierarchy.
- Apply one absolute command deadline across writes and reads, configure write
  timeouts, classify `fread(false)` timeout results correctly and apply the
  64 MiB limit to payload bytes only.
- Clamp negative poll timeouts and non-finite heartbeat intervals safely.
- Require successful worker registration before pulling and avoid stale
  registration state across reconnects.

## [0.1.0] - 2026-07-14

First release. Full producer + sequential worker + flows over the native
TCP protocol, built against the formal wire spec (`docs/protocol.md`) and
certified by the cross-language conformance suite (17/17).

### Added

- `Queue`: `add`/`addBulk` (custom ids preserved through the PUSHB
  `customId` rename), the complete wire job option set (unknown options
  throw — nothing is silently dropped), query/control/DLQ/scheduler/webhook
  /rate-limit/monitoring surface, not-found lookups mapped to `null`.
- `Worker`: blocking `run()` and request-scoped `runOnce()`, time-based
  heartbeats with `JobHeartbeatB` lock renewal between jobs, batch size
  clamped to the server max (1000), heartbeat interval `<= 0` disables,
  `UnrecoverableError` → straight to the DLQ, FAIL stacks persisted with
  the throw site first (per-job `stackTraceLimit` honored), graceful
  SIGTERM/SIGINT handling, exactly-once completion events gated on the ACK
  reaching the server.
- `FlowProducer`: parent/child trees (children first + `UpdateParent`),
  chains, `getFlow` reconstruction with cycle guard, best-effort rollback.
- `Connection`: length-prefixed msgpack framing, Auth-first sessions, lazy
  reconnect with generation tracking, command-timeout socket teardown
  (half-open guard), TLS with certificate verification on by default, and
  the recursive `jsSafe` int64 → float64 guard on every outgoing frame.
- E2e suite (33 tests against a real server) + conformance driver.
