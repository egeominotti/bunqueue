# Changelog

## Unreleased

- Add `Queue.wait_for_job/2`, which omits the timeout and waits up to
  30_000 ms. The `wait_for_job/3` timeout keeps its 0.1.1 meaning: a number is
  clamped to the broker's `0..600_000` ms (`sdk/CLAUDE.md` rule 4), and `nil`
  or a non-number is a 0 ms hold, a poll that returns an unfinished job's
  timeout at once.
- Raise `ArgumentError` for `heartbeat_interval: true` or a non-atom
  non-number such as an unparsed `"10000"`: 0.1.1 silently disabled the
  heartbeats they asked for, so a job that outlived its lease was delivered
  again while still running. Every other worker option value keeps its 0.1.1
  meaning: a heartbeat interval of 0 or less, `nil`, `false` or another atom
  disables heartbeats; `batch_size` is 1 for `nil`, a float or a non-number, an
  integer is clamped to `1..1000` and an omitted one follows `concurrency`;
  `poll_timeout` is a non-blocking 0 for `nil` or a non-number and a number is
  clamped to `0..30_000`.
- Stop the non-blocking poll from spinning: `poll_timeout: 0` (also a negative
  value, `nil` or a non-number, which map to 0) made `run/1` re-poll at
  round-trip speed on an empty queue, measured at 5,000 PULLB commands per
  second. `run/1` now waits 50 ms after an empty pull, mirroring the main
  client's default `drainDelay`.
- Wait 10 ms after an empty pull when `poll_timeout` is above 0, as the main
  client does (`pollTimeout > 0 ? 10 : drainDelay` in
  `src/client/worker/runtime/polling.ts`). A 1 ms long poll re-polled after
  every broker wait: 324 PULLB per second before, 65 after.
- Make `Worker.stop/1` always return. The stop barrier did not monitor the
  runs it admitted, so a run whose process died without leaving it (a handler's
  linked crash kills the `run_once/1` caller, which skips its `after`) held
  `stop/1` forever. Admitted runs are now monitored and a `:DOWN` releases them
  like a `leave`. A live handler is still waited for. A stopper that dies
  before finishing is replaced by the next waiting stopper.
- Keep job heartbeats bounded: a `heartbeat_interval` between 0 and 1 ms was
  truncated to 0, a `JobHeartbeatB` loop per job, and one above 4,294,967,295 ms
  raised `:timeout_value` in the linked heartbeat process, which killed the
  handler task and left `Worker.stop/1` waiting forever. Positive intervals are
  now rounded to at least 1 ms and capped at that limit; non-positive values
  still disable heartbeats.
- Never lease a job for 1 ms: `nil`, every float (even `30_000.0` or
  `60_000 / 2`), and zero, negative or non-numeric `lock_ttl` values were
  silently turned into a 1 ms lease that expired while the job was still
  running. `nil` now means the 30_000 ms default, a positive float is rounded up
  to whole milliseconds, and a value above the broker's limit of
  9,007,199,254,740,991 ms is capped. Zero, negative and non-number values raise
  `ArgumentError` before any worker process starts.
- Normalize connection timeouts: a `timeout` below 1 ms made every connect and
  receive fail at once, and one above 4,294,965,295 ms raised `:timeout_value`
  from `Connection.call/3`. A configured value below 1 ms now falls back to the
  30 s default, an explicit per-call value of at least 0 but below 1 ms to the
  connection's timeout, and larger values are capped. As before, a per-call
  `nil` or `false` uses the connection's timeout and a negative or non-number
  one the 30 s default.
- Negotiate wire protocol v3 and advertise the `separate-job-name`
  capability in `Hello`.
- Send ordinary job names through top-level `"name"`, preserve every user term
  in `"data"`, decode legacy data envelopes, and use `"jobName"` for scheduler
  jobs.
- Keep broker timeouts authoritative when a processor returns or fails late:
  `run_once/1` still reports the settled handler attempt, while an acknowledged
  `already-finalized` ACK/FAIL no-op no longer increments worker terminal
  counters. Reject unknown terminal response evidence as a protocol error and
  cover both real outcomes plus malformed evidence.
- Fix the sustained soak assertion to match the public `Queue.obliterate/1`
  return value, `:ok`.
- Replace multi-command flow creation and best-effort rollback with a pure
  tree/chain planner and one broker-atomic `PUSHF` commit.
- Preallocate secure colon-free IDs, forward explicit job IDs as `customId`,
  make parent/child links and internal markers reciprocal, and reject reserved
  data, topology overrides (including empty values), non-empty/invalid chain
  `children`, repeat, deduplication, and debounce before I/O.
- Validate the exact ID/queue bijection in returned snapshots and construct
  nodes from those authoritative snapshots.
- Add StreamData 1.4.0 tree/chain properties with shrinking, atomic tree and
  chain E2E tests, and separate Muex 0.8.1 mutation campaigns for the pure
  planner and snapshot validator.
- Fix the `deduplication` job option: it was sent as `dedup` without a
  `uniqueKey`, so the broker accepted and ignored it and same-id adds created
  separate jobs. Its `id` now becomes `uniqueKey` (an explicit non-empty
  `uniqueKey` still wins, in any option order) and only
  `ttl`/`extend`/`replace` travel as `dedup`, in `add`, `add_bulk`, and every
  other option path. A missing or empty `id`, unknown fields, a struct, or
  combining it with raw `dedup` raise `ArgumentError`; scheduler job templates
  reject it by name. Regression-tested against a real broker.
- Correct the README: `Hello` is not sent on connect; protocol v3 and the
  `separate-job-name` capability are advertised only by an explicit
  `Bunqueue.Queue.hello/1` call.

## 0.1.1

- Fix `Bunqueue.Job.log/2`: it sent the wire command `Log`, which the server
  rejects as unknown; it now sends `AddLog` like every other SDK, so job log
  lines are actually persisted. Regression-tested against a real broker.
  Known gap: unlike the other SDKs, `log/2` does not accept a `level` yet;
  the server records the line at the default `info` level.

## 0.1.0

- Add OTP-owned plain TCP and verified TLS connections with auth-first lazy
  reconnect, request correlation, command timeouts, and stream teardown.
- Add recursive JavaScript-safe integer encoding, ext-0 tolerance, and
  incoming/outgoing 64 MiB frame limits.
- Add queue producing, query, control, DLQ, scheduler, rate-limit, worker, job,
  and flow APIs.
- Add structured connection telemetry, ExUnit coverage, and the shared
  conformance driver.
- Keep request-sequence state available to connection error recovery and add
  the formatter configuration used by the isolated validation gate.
- Bound pulled leases by processing concurrency, make concurrent worker stops
  race-free, and exercise e2e, authentication, reconnect, and CA-verified TLS
  against disposable real brokers.
- Make worker stop idempotent, clamp client polling to 30 seconds, and map
  integers beyond the float64 range to a typed protocol error.
- Drain active handler executions through an OTP lifecycle barrier before
  unregistering or closing worker connections.
- Emit a payload-free structured `close` event when a connection terminates.
- Terminate the worker lifecycle process after draining while preserving
  race-safe, idempotent repeated stops.
- Include the MIT license in the Hex package contents.
- Ignore Mix build, dependency, documentation, coverage, and Hex archive
  outputs in the SDK worktree.
- Pin development/test dependencies and add concurrent idempotency and
  single-lease races, generated payloads, malformed-term fuzzing, a 512-job
  spike, durable SIGKILL recovery, and a tagged sustained profile.
