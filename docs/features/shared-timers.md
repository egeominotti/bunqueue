# Shared Timers & Durations

> **Category:** Shared utilities · **Source:** `src/shared/timers.ts`, `src/shared/durations.ts`

## Purpose

Bun and Node.js arm a `setTimeout`/`setInterval` whose delay lies outside
[0, 2^31 - 1] ms after about 1 ms and print a `TimeoutOverflowWarning`,
`TimeoutNaNWarning` or `TimeoutNegativeWarning`. A 30-day timeout therefore fires
at once, and a `NaN` or `Infinity` interval ticks hundreds of times per second.
`Bun.sleep` honours long delays (one above 2^31 - 1 ms, or `Infinity`, stays pending
and keeps the process alive), but it resolves `NaN`, negative and sub-millisecond
delays at once, and throws a `TypeError` for a non-number (observed on Bun 1.4.2).

`timers.ts` is the single home of that limit (`MAX_TIMER_DELAY_MS`) and of timers
that accept any delay. `durations.ts` rejects bad durations, and the counts and limits
next to them, where they enter the system (public options, env vars), so they never
reach a timer. Both modules are
dependency-free and are used by the server and the client (they are part of the
portable `bunqueue-client` build).

## Public interface

### `src/shared/timers.ts`

```ts
const MAX_TIMER_DELAY_MS = 2_147_483_647; // 2^31 - 1 ms, about 24.8 days

interface SafeTimer {
  clear(): void; // idempotent; safe inside the callback; clears the chunk armed now
  ref(): SafeTimer; // keep the process alive (the default); applies to later chunks
  unref(): SafeTimer; // let the process exit; applies to later chunks
}

function safeTimeout(fn: () => void, delayMs: number): SafeTimer;
function safeInterval(fn: () => void, periodMs: number): SafeTimer;
function safeDeadline(fn: () => void, deadlineEpochMs: number): SafeTimer;
function clampTimerDelay(ms: number): number;
```

Every function above also takes a trailing `chunkMs` (default
`MAX_TIMER_DELAY_MS`, valid range 1..2^31 - 1). It is a test seam that lets tests
exercise the chunked path in milliseconds; production code never passes it.

| Input                 | `safeTimeout`                       | `safeInterval`                          | `safeDeadline`                  | `clampTimerDelay` |
| --------------------- | ----------------------------------- | --------------------------------------- | ------------------------------- | ----------------- |
| in range              | one native `setTimeout(fn, ms)`     | one native `setInterval(fn, ms)` if > 0 | chunk(s), wall clock re-checked | `ms`              |
| > 2^31 - 1, finite    | chunks against a monotonic deadline | re-armed per period, in chunks          | chunks, wall clock re-checked   | `2^31 - 1`        |
| `Infinity`            | arms nothing, never fires           | arms nothing, never ticks               | arms nothing, never fires       | `2^31 - 1`        |
| negative, `-Infinity` | behaves like 0 (next timer tick)    | `RangeError` (a spin)                   | past deadline: next timer tick  | `0`               |
| `0`                   | native, next timer tick             | `RangeError` (a spin)                   | (epoch 0 is a past deadline)    | `0`               |
| `NaN`, non-number     | `TypeError`                         | `TypeError`                             | `TypeError`                     | `TypeError`       |

Semantics in detail:

- **`safeTimeout(fn, delayMs)`** runs `fn` once after `delayMs` of monotonic time
  (`performance.now()`, the clock native timers use), so a wall-clock change does
  not move it. A delay that fits passes `fn` itself to native `setTimeout`: no
  closure, no clock read. A longer delay stores one absolute monotonic deadline and
  arms at most 2^31 - 1 ms at a time; each chunk re-reads the clock and arms what
  remains (rounded up), so the callback is never early, does not drift, and runs
  exactly once. Fractions are passed through; negative values (and `-0`,
  `-Infinity`) fire on the next timer tick, never synchronously.
- **`safeInterval(fn, periodMs)`** runs `fn` every `periodMs`. A period that fits is
  one native `setInterval`. A longer one re-arms per period: the next deadline is
  armed before `fn` runs, as native intervals do, so `clear()` inside `fn` stops
  it and a throwing `fn` keeps it armed; after a stall longer than several periods
  it fires once, then one period later (no burst). Periods of `0` or below throw a
  `RangeError`, because the runtime would turn them into a 1 ms spin.
- **`safeDeadline(fn, deadlineEpochMs)`** runs `fn` once when `Date.now()` reaches an
  epoch-ms deadline. Every chunk, the last one included, re-reads the wall clock,
  so a clock set back re-arms instead of firing early. A deadline already past
  fires on the next timer tick. Use it for persisted or wire-provided absolute
  deadlines (a job wait TTL); use `safeTimeout` for relative delays.
- **`clampTimerDelay(ms)`** returns one valid native delay for code that must hand a
  single delay to an abstraction (the workflow engine's injectable clock
  `clock().setTimeout`, a re-check loop). Finite values clamp to [0, 2^31 - 1],
  `Infinity` to 2^31 - 1 and `-Infinity` to 0. A clamped delay can fire before the
  real deadline, so the caller must re-check what remains when it fires. `NaN`
  throws, like every helper here.
- **`Infinity`** means "never": nothing is armed, so an `Infinity` timer also never
  keeps the process alive; its `clear`/`ref`/`unref` are no-ops. Something else must
  hold the process open if that is wanted.
- **`NaN`** is a programming error (a missing option, a failed parse), not a delay.
  The helpers throw a `TypeError` at the arming site instead of letting the runtime
  turn it into a 1 ms timer.
- **ref/unref** follow native timers: a timer is ref'd by default; the setting
  applies to the native timer armed now and to every chunk armed later. After a
  timer fired or was cleared they are harmless no-ops. Always cancel through
  `timer.clear()`: `clearTimeout(timer)` does not accept a `SafeTimer` (a type error).

### `src/shared/durations.ts`

```ts
interface DurationOptions {
  min?: number; // inclusive, default 0
  max?: number; // inclusive, default unbounded
  allowInfinity?: boolean; // accept Infinity ("never") whatever max is, default false
  integer?: boolean; // require whole milliseconds, default false
}
function assertDuration(value: unknown, name: string, opts?: DurationOptions): number;

interface IntegerOptions {
  min?: number; // inclusive, default Number.MIN_SAFE_INTEGER (not printed)
  max?: number; // inclusive, default Number.MAX_SAFE_INTEGER (not printed)
  allowInfinity?: boolean; // accept Infinity ("no limit") whatever max is, default false
  unit?: string; // printed in the message: 'bytes'; none by default
}
function assertInteger(value: unknown, name: string, opts?: IntegerOptions): number;

interface EnvDurationOptions {
  min?: number; // inclusive, default 0
  max?: number; // inclusive, default Number.MAX_SAFE_INTEGER
  allowZero?: boolean; // accept 0 even when min > 0 (0 = disabled), default false
}
interface EnvIntegerOptions extends EnvDurationOptions {
  unit?: string; // printed in the message: 'requests', 'bytes', 'milliseconds'; none by default
}
function parseIntegerEnv(
  name: string,
  raw: string | undefined,
  fallback: number,
  opts?: EnvIntegerOptions
): number;
function parseDurationEnv(
  name: string,
  raw: string | undefined,
  fallback: number,
  opts?: EnvDurationOptions
): number; // parseIntegerEnv with unit 'milliseconds'
function describeValue(value: unknown): string; // how a received value is shown in messages
```

- **`assertDuration`** is for public client options and method arguments. It
  returns the value or throws a `TypeError` (not a number) or a `RangeError` (NaN,
  an infinity without `allowInfinity`, a fraction with `integer`, or outside
  [min, max]). `name` is printed verbatim, so include the owner:
  `Worker: heartbeatInterval must be a finite number of milliseconds >= 0 (got NaN)`.
  Strings are quoted (`(got "100")`), objects shown as `an object`.
- **`assertInteger`** is the same check for counts and limits next to durations
  (attempts, in-flight slots, a pool size, a byte cap): a safe integer within
  [min, max], or `Infinity` with `allowInfinity`. It throws a `TypeError` for a
  non-number and a `RangeError` for NaN, a fraction, an infinity without
  `allowInfinity`, an integer beyond `Number.MAX_SAFE_INTEGER` (`2 ** 53 + 1 === 2 ** 53`,
  so a bound or counter there is not exact) or a value out of range, worded as
  `a whole number`, e.g.
  `TcpClient: maxInFlight must be a whole number >= 1 or Infinity (got 0)`,
  `TcpServerConfig.maxWriteQueueBytes must be a whole number of bytes >= 0 (got -1)` or
  `Queue: autoBatch.maxSize must be a whole number >= 1 (got 9007199254740992, not a safe integer)`.
  `-0` is a whole number. A `min` or `max` it leaves out defaults to the safe-integer
  bound and is not printed. Use it for every whole-number option instead of a
  hand-rolled `Number.isSafeInteger` check, so the error type (TypeError for a
  non-number) and the wording match everywhere.
- **`parseIntegerEnv`** is the shared whole-number env parser (counts, sizes, ports
  and durations). It is not yet the only one: some modules still parse their own
  (for example the MCP HTTP settings in `src/mcp/transportConfig.ts`); new code uses
  this one. `undefined` or `''` returns `fallback` (returned as
  given, not validated). Anything else must be, after trimming, decimal digits only
  and a safe integer within the limits; signs, decimals, exponents, hex, separators,
  units and whitespace-only values throw:
  `Invalid RATE_LIMIT_MAX_REQUESTS: "1e4" (expected a whole number of requests >= 1)`.
  The server configuration (`src/config/numbers.ts`), the runtime limits
  (`RATE_LIMIT_MAX_REQUESTS`, `TCP_MAX_WRITE_QUEUE_BYTES`) and every duration use it;
  it replaces `src/infrastructure/server/envInteger.ts`.
- **`parseDurationEnv`** is `parseIntegerEnv` in milliseconds:
  `Invalid STATS_INTERVAL_MS: "abc" (expected a whole number of milliseconds >= 0)`.
  Values above 2^31 - 1 are valid: the timer helpers honour them.
- **`describeValue`** formats a received value for every validation message here
  and in `src/config/` (strings quoted, `-0` kept, objects summarized, never
  printed), so the wording cannot drift between modules.

## Validation policy

- **Public client options and arguments** (Queue, Worker, workflow DSL): validate
  with `assertDuration` (durations) or `assertInteger` (counts) at the boundary
  (constructor or method entry) so the error names the option. Throwing there is
  the contract; never clamp silently.
- **Server env vars and config**: parse with `parseIntegerEnv` / `parseDurationEnv`
  and let the error stop startup. This follows `src/config/resolve.ts`, which
  already fails fast on an unsupported storage driver and on partial TLS config.
- **Internal computed delays** (remaining = deadline - now): arm with `safeTimeout`
  / `safeDeadline`, or `clampTimerDelay` plus a re-check where an abstraction needs
  one native delay. A `NaN` here is a bug upstream, and the helpers throw rather
  than spin.
- **Delays computed from persisted state** (a cron `nextRun`, a workflow wait start,
  a child's `createdAt`) can be corrupted, and a throw inside a scheduler loop would
  stop every other entry. Such call sites check `Number.isFinite` before calling a
  helper and handle the bad value explicitly: cron reschedules the entry from now
  and reports it, a `waitFor` gate or sub-workflow node fails with a reason naming
  the bad value, and the job timeout scheduler re-checks in 1 ms. Never pass such a
  value to a helper and rely on its TypeError.
- **`Bun.sleep`** honours long delays, so a sleep of an already validated duration
  needs no wrapper. It resolves `NaN` and negative delays at once, so a duration that
  can be `NaN` (a computed or unvalidated one) must be validated first, or armed with
  `safeTimeout`, which throws on `NaN`. In the portable `bunqueue-client` build,
  `Bun.sleep` becomes `sleep` from `sdk/typescript/src/canonical-transport/runtime.ts`,
  a `safeTimeout` with `Bun.sleep`'s semantics (`test/tcp-parity-timers.test.ts`):
  a raw `setTimeout` there ran a 30-day sleep after about 1 ms.

## Hot-path guidance

`safeTimeout` with an in-range delay is a `typeof` check, three comparisons, the
native `setTimeout(fn, delayMs)` with the caller's own `fn`, and one small wrapper
object. Measured natively (Apple Silicon, Bun 1.4.2, 1M iterations, median of 7
interleaved rounds, three runs), arm-and-clear costs:

| Pattern                               | ns/op     |
| ------------------------------------- | --------- |
| `clearTimeout(setTimeout(fn, 30000))` | 46.1–47.2 |
| `safeTimeout(fn, 30000).clear()`      | 47.5–48.9 |
| native with `unref()`                 | 48.1–49.4 |
| `safeTimeout(...).unref()` + clear    | 50.0–50.8 |

The overhead is about 1.5 ns (~3%), or 0.15 ms of CPU per second at 100k timers
per second, so hot paths (the per-command TCP timeout, the per-job processing
timeout) should simply use `safeTimeout` and keep the returned `SafeTimer` where
they kept the native handle, calling `timer.clear()` instead of `clearTimeout`.
There is no separate native-handle API. Code that already keeps one native timer
and re-checks a deadline when it fires (the job timeout scheduler, cron) may keep
native `setTimeout(fn, clampTimerDelay(ms))`.

## Users

Generated from the imports: `git grep --untracked -n "shared/timers\|shared/durations" -- src sdk`,
plus `./timers` / `./durations` inside `src/shared/` and `./timing.js` in the legacy
SDK entry. A module that only holds a timer imports the `SafeTimer` type; such
type-only imports are listed with the module that arms the timer.

### Shared primitives (`src/shared/`)

- `asyncLock.ts`, `rwLock.ts`: each lock wait's timeout is a `safeTimeout`.
- `lockTimeout.ts` (`LOCK_TIMEOUT_MS`) and `workerTimeouts.ts` (`WORKER_TIMEOUT_MS`,
  `WORKER_CLEANUP_INTERVAL_MS`): `parseDurationEnv` for the env var and
  `assertDuration` for the programmatic value.

### Server configuration (`src/config/`)

- `numbers.ts`: every numeric env var and config-file value of the settings table
  (`settings.ts`) goes through `parseIntegerEnv` / `assertDuration`, with
  `describeValue` in its own messages ([Configuration](./configuration.md)).
- `schema.ts`: config-file messages use `describeValue`.

### Engine and background work (`src/application/`, `src/domain/`)

- `background/lifecycle.ts` (cleanup, dependency, stall, DLQ and lock checks) and
  `workerManager.ts` (stale worker cleanup): `safeInterval`s
  ([Background Tasks](./background-tasks.md)).
- `background/timeouts.ts`: `timeoutTimerDelay` = at least 1 ms, then
  `clampTimerDelay`; a NaN distance is 1 ms. `types/background.ts` holds the
  `SafeTimer` handles.
- `types/config.ts`: the `QueueManager` interval settings are validated with
  `assertDuration` (min 1).
- `eventsManager.ts`: `waitForJobCompletion` validates its timeout with
  `assertDuration` and arms it with `safeTimeout`.
- `postgres-queue-manager/projectionRefreshes.ts`, `queueRefreshes.ts`: retry delays
  validated with `assertDuration`, armed with `safeTimeout`
  ([PostgreSQL Multi-Broker Persistence](./postgres-multibroker.md)).
- `domain/queue/waiterManager.ts`: each pull wait is a `safeTimeout`; a NaN timeout
  is rejected before arming ([Job Lifecycle](./job-lifecycle.md)).

### Server infrastructure (`src/infrastructure/`)

- `scheduler/cron/runtime.ts`: `clampTimerDelay` for the next cron wake, after
  `repairNextRun` has rescheduled any non-finite `nextRun`
  ([Scheduler & Cron](./scheduler-and-cron.md)).
- `server/rateLimiter.ts`: `RATE_LIMIT_*` env vars through `parseDurationEnv` /
  `parseIntegerEnv`, programmatic values through `assertDuration` / `assertInteger`
  (`maxRequests`), and the cleanup sweep is a `safeInterval`.
- `server/tcp/constants.ts`: `TCP_IDLE_TIMEOUT_MS` / `TCP_MAX_WRITE_QUEUE_BYTES` and
  `TcpServerConfig.idleTimeoutMs` / `maxWriteQueueBytes` (`assertInteger` with unit
  `bytes`); `tcp/connections.ts` arms the per-socket stall timer with `safeTimeout`
  (`types/tcpServer.ts` holds it) ([TCP Wire Protocol & Framing](./tcp-protocol.md)).
- `server/statsLog.ts` (the statistics log line, `safeInterval`) and
  `server/shutdownCoordinator.ts` (each shutdown step's deadline, `safeTimeout`).
- `backup/s3Backup.ts` (the backup schedule, `safeInterval`) and `backup/s3BackupIo.ts`
  (each S3 call's timeout, `safeTimeout`) ([S3 Backup](./backup-s3.md)).
- `persistence/postgres/runtimeConfig.ts` (session timeouts and intervals,
  `assertDuration`), `events.ts` (the event poll, `safeInterval`, and each wake wait,
  `safeTimeout`), `maintenanceSchedule.ts` (periodic sweeps, `safeInterval`) and
  `postCommitMaintenance.ts` (retry delay, `assertDuration` + `safeTimeout`).

### CLI (`src/cli/`)

- `client.ts`: each command's response timeout is a `safeTimeout`.

### Embedded and TCP client (`src/client/`)

Client option validation normalizes before it asserts, so every value 2.9.10
handled with a defined result keeps that result: `tcp/numeric.ts` reads a
plain-digit string (`port: process.env.PORT`) as its number; fractional counts
round as 2.9.10's comparisons did; a negative or `NaN` interval or timeout that
2.9.10 guarded with `> 0` means disabled; and an option the active mode does not
use (`drainDelay` with a long poll, `lockDuration` without locks) is not checked.
`assertDuration` / `assertInteger` then reject only what 2.9.10 could not run.

- `job-wait/session.ts`: the wait TTL and the final read use `safeDeadline`; its
  sleeps are `safeTimeout`s (`test/job-wait-long-deadline.test.ts`,
  `test/repro-wait-long-ttl.test.ts`).
- `queue/addBatcher.ts`: `autoBatch.maxSize` (`assertInteger`) and `maxDelayMs`
  (`assertDuration`) are validated, and the batch window is a `safeTimeout`
  ([Client SDK: Queue](./client-queue-sdk.md)).
- TCP transport ([Client Transport](./client-transport.md)): `tcp/options.ts`
  validates every `ConnectionOptions` / `PoolOptions` duration (`assertDuration`) and
  count, port and pool size (`assertInteger`); the per-command and Auth timeouts
  (`runtime/commands.ts`, the hot path; `types/command.ts` holds them), the connect
  deadline (`transport.ts`) and the reconnect backoff (`reconnect.ts`) are
  `safeTimeout`s, and the health ping (`health.ts`) is a `safeInterval`.
- Worker ([Client SDK: Worker](./client-worker-sdk.md)): `worker/runtime/options.ts`
  validates the durations (`assertDuration`) and `concurrency` / `batchSize`
  (`assertInteger`); `runtime/control.ts` validates `Worker.concurrency`,
  `rateLimit` and `delay`, arms `delay` with `safeTimeout` and the job heartbeat with
  `safeInterval`; `runtime/execution.ts` (refill retry and per-job processing
  timeout, `safeTimeout`; worker heartbeat, `safeInterval`), `runtime/manual.ts`
  (manual-job timeout, `safeTimeout`; `extendJobLocks` duration, `assertDuration`),
  `runtime/polling.ts` (the poll timer, `safeTimeout`; `runtime/state.ts` holds it),
  `ackBatcher.ts` (the ACK batch delay, `safeTimeout`) and `workerHeartbeat.ts`
  (`safeInterval`).
- Sandboxed workers: `sandboxed/runtime/options.ts` validates the durations
  (`assertDuration`) and `concurrency` (`assertInteger`); `dispatch.ts` (per-job
  timeout), `pool.ts` (idle poll) and `lifecycle.ts` (auto-start poll) arm
  `safeTimeout`s, and `recovery.ts` (job heartbeat) a `safeInterval`;
  `runtime/state.ts` and `types/process.ts` hold the handles.
- Simple Mode ([Simple Mode](./simple-mode.md)): `bunqueue/validation.ts` validates
  every feature option (`assertDuration`, `assertInteger`, `describeValue`) and
  `bunqueue.ts` the `cancel()` grace period; `retry.ts` (retry wait; a
  `customBackoff` result that is negative, `NaN`, `undefined` or `null` retries at
  once, and only an infinite or non-numeric one fails the job), `batch.ts` (flush),
  `cancellation.ts` (cancel grace) and `circuitBreaker.ts` (reset) arm `safeTimeout`s,
  and `aging.ts` (priority aging) a `safeInterval`.
- Workflow engine ([Workflow Engine](./workflow-engine.md)): `workflow/waitFor.ts`,
  `runnerTiming.ts` and `subWorkflowRunner.ts` pass each delay through
  `clampTimerDelay` to the engine clock, after a non-finite wait start or child start
  has failed the node.

### MCP server (`src/mcp/`)

- `backend/tcp/env.ts`: `BUNQUEUE_PORT` and `BUNQUEUE_POOL_SIZE` through
  `parseIntegerEnv`, against the TCP client's bounds.

### Portable and legacy SDK (`sdk/typescript/src/`)

- `canonical-transport/runtime.ts` maps `Bun.sleep` to a `safeTimeout`, and
  `canonical-transport/transport.ts` arms the Node.js connect deadline with
  `safeTimeout`.
- `timing.ts` re-exports both modules to the legacy entry `bunqueue-client/legacy`
  (imported, not copied; the build bundles them into the chunk the default entry
  uses), plus `safeSleep`. Through it:
  - `validation.ts` and `bunqueue/validation.ts` validate the Connection,
    ConnectionPool, Queue, Worker and Simple Mode options (`assertDuration`,
    `assertInteger`, `describeValue`), but reject only values 0.2.2 turned into a
    hot loop, a hang, a crash or a ~1 ms timer. `legacy-coercion.ts` keeps every other
    0.2.2 result: `numericString` reads a numeric string as its number, and
    `legacyDelay` makes a `NaN` or negative one-shot delay 0 (at once) and rejects
    `Infinity` unless it means "never". `ackBatch.maxDelayMs`, Simple Mode
    `retry.delay`, a `customBackoff` result, `circuitBreaker.resetTimeout`,
    `batch.timeout` and the `cancel()` grace period (`bunqueue/bunqueue-api.ts`) go
    through `legacyDelay`. The four SDK-clamped options are the exception
    (`sdk-clamps.ts`). A 0, negative, non-finite or non-number heartbeat disables
    it. `batchSize`, the poll timeout and the `waitForJob` ttl clamp: a non-finite
    or non-number `batchSize` means 10, a numeric string poll timeout or ttl is its
    number, `NaN` means the default, and a `null` ttl is a 0 ms hold. Their
    non-number messages use `describeValue`. `sdk/typescript/LEGACY.md` ("Option
    validation") lists each option.
  - `connection.ts` (command deadline), `socket-factory.ts` (connect deadline),
    `ack-batcher.ts` (ACK batch delay) and `bunqueue/retry.ts`, `batch.ts`,
    `cancellation.ts`, `circuit-breaker.ts` arm `safeTimeout`s; `bunqueue/rate-gate.ts`
    waits with `safeSleep`; `worker.ts` (heartbeat) and `bunqueue/aging.ts` arm
    `safeInterval`s; `connection-types.ts` and `worker-base.ts` hold the handles
    (`sdk/typescript/tests/legacy-*-durations.test.ts`,
    `tests/legacy-compat-*.test.ts`, `tests/e2e-durations.ts`,
    `tests/e2e-legacy-compat.ts`).

## Tests

- `test/shared-timers.test.ts`, `test/shared-timers-interval.test.ts`: a fake
  runtime (manual wall and monotonic clocks, spied native timers restored in
  `afterEach`) that also asserts no out-of-range delay ever reaches a native timer.
- `test/shared-timers-real.test.ts`: real timers with tiny injected chunks, and
  fresh Bun processes (a 30-day timeout keeps a script alive, unref'd ones let it
  exit, a 30-day interval ticks 0 times in 300 ms, and no helper makes the runtime
  emit a `Timeout*Warning` for any value).
- `test/shared-durations.test.ts`: every accepted and rejected shape and message,
  for `assertDuration`, `assertInteger`, `parseIntegerEnv`, `parseDurationEnv` and
  `describeValue`.
