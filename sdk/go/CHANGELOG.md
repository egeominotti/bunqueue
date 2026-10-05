# Changelog

All notable changes to the bunqueue Go SDK are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A negative `PollTimeoutMs` (non-blocking pulls) no longer spins: the worker
  sent about 10,000 `PULLB` per second to an empty queue. It now waits 50 ms
  after an empty non-blocking pull, the main client's default `drainDelay`.
- A short long poll no longer re-polls an empty queue hundreds of times per
  second: with `PollTimeoutMs: 1` the worker sent about 705 `PULLB` per second.
  Like the main client (`pollTimeout > 0 ? 10 : drainDelay`), it now waits
  10 ms after an empty long poll (about 77 per second at 1 ms).
- `Stop` now ends `Run` promptly even while the pull loop is waiting. The
  waits were plain sleeps, and `Run` returned only after they ended:
  - the empty-pull wait (10/50 ms; measured 47 ms);
  - the error backoff (0.5–5 s; measured 480 ms);
  - the 20 ms wait while every slot is busy.

  Each wait now selects on the worker's stop channel and a timer, stopping the
  timer when stop wins. `Run` returns in under 1 ms.
- A positive `HeartbeatIntervalS` below 1 ns, or above the `time.Duration`
  range on amd64, no longer panics `time.NewTicker` inside `Run()`. The period
  is clamped to [1 ms, max `time.Duration`], and `HeartbeatIntervalS()` reports
  the effective value.
- A negative `LockTtlMs` uses the 30000 ms default instead of reaching the
  broker, which granted a lease that had already expired, so a job could be
  delivered again while it was still running.
- A negative `Options.ConnectTimeout` or `Options.CommandTimeout` uses its
  default instead of a deadline in the past, which failed every dial, or timed
  out every command and reconnected once per call.

## [0.2.0] - 2026-10-02

Breaking: `Job.Data()` now returns `any` (it was `map[string]any`) and invalid
options are rejected. Requires a bunqueue server 2.8.57 or later (wire protocol
v3).

### Changed

- Negotiate wire protocol v3 and advertise the `separate-job-name`
  capability in `Hello`.
- Send ordinary job names through top-level `name`, preserve arbitrary user
  `data`, decode legacy data envelopes, and use `jobName` for scheduler jobs.
  `Job.Data()` now returns `any` so slices, scalars, and nil remain intact.
- Replace multi-command flow creation and rollback with a preallocated,
  reciprocal graph committed by one atomic `PUSHF`.
- Require exact ID and queue agreement in authoritative commit snapshots.
- Reject invalid queue names, reserved markers, user-owned topology options,
  and repeat/deduplication/debounce before transport.

### Fixed

- Suppress local `completed`/`failed` events and worker counters when the
  broker reports a late `ACK`/`FAIL` as
  `{applied:false, reason:"already-finalized"}`. Malformed outcome evidence is
  surfaced as a Worker `error` instead of fabricating a terminal transition.

### Added

- Rapid 1.3.0 shrinking properties for tree and chain topology, wire
  preservation, one-command atomicity, secure IDs, and invalid-input no-I/O.
- Gremlins 0.6.0 mutation gate for the pure planner, ID generator and snapshot
  validator, with 99.9% thresholds and a JSON report.
- Language-specific invariant and contributor documentation, including the
  compile-time `ChainStep` no-children guarantee.

## [0.1.0] - 2026-07-20

First tagged release: `go get github.com/egeominotti/bunqueue/sdk/go@v0.1.0`
(monorepo tag `sdk/go/v0.1.0`). Before this tag the module was only
installable as a pseudo-version.

### Added

- Optional payload-free connection telemetry through `Options.OnEvent` and
  `WorkerOptions.OnEvent`, covering connection, reconnection, authentication,
  commands, timeouts, errors and close with callback panic isolation.
- Rate-limit duration and broker-side TTL through `RateLimitOptions`.
- Scheduler `preventOverlap`, explicit `skipMissedOnRestart` booleans and
  direct `uniqueKey` forwarding.
- Add independent-connection races, 500 generated wire-property cases, a
  512-job spike, a native fuzz target, race-detector coverage, and an opt-in
  sustained profile.

### Fixed

- Recursively validate JavaScript-safe integers in typed maps, slices,
  pointers and structs instead of checking only `map[string]any` payloads;
  cyclic graphs and non-string map keys now fail with a typed connection error.
- Normalize `time.Time` payload values to JavaScript-safe Unix milliseconds.
- Normalize nested MessagePack ext type 0 values to `nil`.
- Apply the 64 MiB outgoing limit to the MessagePack body, excluding the
  four-byte frame header.
- Isolate pull, ACK/FAIL and heartbeat traffic on separate worker connections
  so long polling cannot delay completion or lock renewal.
- Treat zero, negative and non-finite heartbeat intervals as disabled, clamp
  negative poll timeouts and require successful worker registration before
  pulling.
