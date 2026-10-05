# Job Options Validation

> **Category:** Domain · **Source:** `src/domain/job/options.ts`, `optionBounds.ts`,
> `optionNormalize.ts`, `commandArguments.ts`, `mutations.ts`

## Purpose

A job duration that is NaN, infinite, negative or out of range does damage far from
where it entered: `runAt = now + NaN` never comes due, a NaN lease never expires, SQLite
drops a NaN in a `NOT NULL` column (`created_at`, `run_at`, `backoff`), and a timer armed
with it fires after about 1 ms (see [Shared Timers & Durations](./shared-timers.md)).
Before this module, TCP `PUSH`/`PUSHB` validated a subset of the options, atomic flows
kept a private copy of the bounds, and embedded `Queue.add`/`addBulk` and cron templates
validated nothing.

`options.ts` is the single validator. Every entry point calls it, so embedded and TCP
mode reject the same input with the same message.

**Compatibility rule.** A bound refuses only what cannot be honoured: a value that is
not a number, NaN or an infinity (it never comes due, never expires, or breaks the heap
order or a `NOT NULL` column), a negative `timeout`/`ttl` or `backoff.delay`, a
`backoff.maxDelay` above one day, a `timestamp` outside the Date range. Every value
2.9.10 ran
with a well-defined result (in embedded, TCP or HTTP mode) is admitted, and
`normalizeJobInput` (`optionNormalize.ts`) stores it the way 2.9.10 effectively used it:
a plain decimal numeric string (`'3'`, `' -2.5 '`) is its number, `attempts` of 0 or
less runs once, a fractional `attempts` rounds up, `attempts: Infinity` (or above the
PostgreSQL INTEGER range) is 2,147,483,647, and a finite duration beyond
±`MAX_JOB_DURATION_MS` (4.32e15 ms, half the Date range, about 136,900 years) is
clamped to it. A non-finite duration is never turned into a finite one: the entry points
refuse it, and one a direct `QueueManager` caller stores keeps the shared rules' 2.9.10
meaning (a ±Infinity or NaN `timeout` is no timeout, as 2.9.10's broker treated it). The engines
(`QueueManager.push/pushBatch`, the PostgreSQL overrides) normalize at admission and
`createJob` normalizes again, so internal callers (cron spawns, direct `QueueManager`
use) store the same job. A client from 2.9.10 talking to this server gets 2.9.10's
result for every command it sends.

| Entry point                                   | Where                                                       | On error                     |
| --------------------------------------------- | ----------------------------------------------------------- | ---------------------------- |
| TCP/HTTP `PUSH`                               | `handlers/core.ts` (`validateJobOptions(cmd)`)              | `{ ok: false, error }`       |
| TCP/HTTP `PUSHB`                              | `handlers/pushBatchValidation.ts`                           | `jobs[i]: <error>`           |
| Atomic flows (`PUSHF`, embedded, PostgreSQL)  | `operations/flowValidation.ts` (`assertJobOptions`)         | thrown `Error`               |
| Embedded and TCP `Queue.add`/`addBulk`        | `client/queue/operations/add/validation.ts`                 | thrown `Error` (bulk: `jobs[i]:`) |
| Cron/job-scheduler templates (all backends)   | `scheduler/cron/validation.ts` (`assertValidCronInput`)     | thrown / `{ ok: false }`     |
| `ChangeDelay`, `MoveToDelayed`                | handlers + `QueueManager.changeDelay/changeWaitingDelay`    | protocol error / thrown      |
| `PULL`/`PULLB` `lockTtl`, `ExtendLock(s)`, `JobHeartbeat` `duration` | handlers + `QueueManager` lock methods | protocol error / thrown |
| `PULL`/`PULLB` `timeout`                                      | handlers (`validatePullTimeout`, 0..60,000, as 2.9.10)      | protocol error               |
| `QueueManager.pull*` `timeoutMs` (direct API)                 | `pullTimeoutArgument`: negative/NaN = 0, otherwise honoured (no cap), never thrown | —        |
| MCP `add_job`/`add_jobs_bulk` (embedded backend)               | `mcp/backend/jobOptions.ts` (`admittedJobInput`)            | MCP `{ error }`              |
| `ChangePriority`, `Progress`, `Update` (every caller)          | `QueueManager.changePriority/updateProgress/updateJobData` (`domain/job/mutations.ts`) | protocol error / thrown |
| `ClearLogs` `keepLogs` (every caller)                          | `QueueManager.clearLogs` + the `ClearLogs` handler (`validateKeepLogs`) | protocol error / thrown |

The client validates `add`/`addBulk` in TCP mode too, before the auto-batcher: an
invalid add rejects on its own with the plain message instead of failing every add in
its `PUSHB` batch with `jobs[i]:`. The server still validates every command it receives.
Every job method that takes a duration checks its argument first with the same
validators (`src/client/queue/commandArgs.ts`), because several TCP paths ignore the
reply: the Queue's `changeJobDelay`, `moveJobToDelayed` and `extendJobLock`, and
`changeDelay`/`moveToDelayed`/`extendLock` on Queue, DLQ, FlowProducer and Worker
processor jobs (sandboxed jobs reuse the Worker handlers). `moveToDelayed(timestamp)`
needs a finite timestamp (`delayUntil`; a past one means now, one beyond the honoured
range is clamped). `extendLock(token, duration)` takes any finite duration, as the
broker does (2.9.10 resolved `extendLock(token, 0)` with 0).
`extendLock` reports the same way in both modes (`lockExtensionResult`): `duration`
when the lease was extended, `0` when the broker has no matching lease
(`LOCK_NOT_EXTENDED_ERROR`, the BullMQ result), and a thrown error for any other
rejection. Before, a Worker job's TCP `extendLock` resolved 0 for every rejection and a
flow or DLQ job's threw even for a missing lease.

**Setter outcomes.** Every job setter reports a job it cannot change the same way on
every path (Queue methods, Queue jobs from `add`/`getJob`, FlowProducer jobs, DLQ jobs)
and in both modes. TCP replies are always read (`commandArgs.ts`). Invalid arguments
always throw.

| Setter | Job it cannot change | Why |
| ------ | -------------------- | --- |
| `changeDelay` / `changeJobDelay` | resolves, nothing changes (`Job not found or cannot change delay` is skipped) | 2.9.10's result in both modes; it races with the job maturing, being pulled or finishing. A Worker processor's own `changeDelay` still throws (2.9.10 did too): its delivery must end there |
| `updateData` / `updateJobData` | throws `Job not found or cannot be updated` | a lost update is data loss (a later retry would run the old data); TCP `Queue.updateJobData` already threw on 2.9.10 |
| `promote` / `promoteJob` | resolves, nothing changes (`Job not found or not delayed` is skipped) | races with the job maturing or being pulled; every Queue/Worker path already behaved so |
| `updateProgress` / `updateJobProgress` | resolves, nothing changes (`Job not found`, `Job is not active ...` are skipped) | races with timeouts and stalls; the engine only tracks progress of active jobs |
| `changePriority` / `changeJobPriority` | resolves, nothing changes (`Job not found or not in queue` is skipped) | races with the job being pulled |
| `extendLock` | resolves `0` | BullMQ's documented result |

Before, flow and DLQ jobs threw over TCP for `changeDelay`, `promote` and progress while
the same calls resolved embedded; `updateData` threw over TCP and resolved embedded; and
`Queue.changeJobDelay`, `promoteJob`, `updateJobProgress` and the Queue job objects ignored
the TCP reply. `updateJobProgress` and every job object's `updateProgress` (Worker and
SandboxedWorker included) map progress with `progressUpdate`, the broker's
`normalizeProgress`, which never throws, so an `updateProgress('50%')` cannot fail the
job (2.9.10 completed it): a number is kept (NaN is 0), an object is 0 plus its JSON
message, a numeric string, a boolean and null are `Number(value)` (`'50'` is 50, `true`
is 1, `null` is 0, as 2.9.10 stored them), and other text is 0 with the text as the
message (2.9.10 stored NaN). The Worker's `progress` event still carries the value the
processor passed. The broker applies the same mapping, so a 2.9.10 client sending
`progress: '50'` gets 50 stored. The broker messages are constants in
`src/domain/job/mutations.ts`, shared by the handlers and the clients.

HTTP routes build TCP commands and call the same handlers. `POST /queues/:queue/jobs`
forwards exactly the fields it forwarded on 2.9.10 (`name`, `data`, `priority`,
`delay`, `maxAttempts`/`attempts`, `backoff`, `timeout`, `jobId`, `removeOnComplete`,
`removeOnFail`, `durable`, `ttl`, `uniqueKey`, `groupId`, `dependsOn`, `tags`, `lifo`,
`repeat`) and ignores every other key: forwarding more failed bodies that worked (an
ISO `timestamp`, `stallTimeout: "30000"`) and changed the meaning of others
(`timestamp: 1000` became the creation time). `POST /queues/:queue/jobs/bulk` forwards
whole PUSHB jobs. Numeric query parameters (`timeout` on `GET /queues/:queue/jobs`,
`limit`/`offset` on `GET /queues/:queue/jobs/list`) are read with `parseInt`, as on
2.9.10 (`5000ms` is 5000, `1e3` is 1, `10.0` is 10); an invalid pull wait is reported by
the PULL handler with status 200 and `ok: false` (`timeout must be at most 60000`,
`timeout must be a finite number` for an empty or non-numeric value).

## Public interface

```ts
validateJobOptions(options: JobOptionFields, prefix = '', names = WIRE_OPTION_NAMES): string | null;
assertJobOptions(options: JobOptionFields, prefix = '', names = WIRE_OPTION_NAMES): void;
normalizeJobInput(input: JobInput): JobInput; // the stored form (optionNormalize.ts)
validateBackoffField(value: unknown, prefix = ''): string | null;
validateNumericField(value, name, { min?, max?, required?, integer? }): string | null;
validateDelayArgument(value: unknown, name = 'delay'): string | null; // + assertDelayArgument
delayArgument(value: unknown, name = 'delay'): number; // applied delay, clamped to ±MAX_JOB_DURATION_MS
validateLockDuration(value: unknown, name: string): string | null; // + assertLockDuration
validatePullTimeout(value: unknown): string | null; // + assertPullTimeout, 0..60000 (wire)
pullTimeoutArgument(value: unknown): number; // QueueManager.pull*: < 0 or NaN is 0, no cap
jobRunDelay(delay: unknown): number; // createJob: runAt = createdAt + jobRunDelay(delay)
coerceNumericString(value: unknown): unknown; // optionBounds.ts
const LOCK_NOT_EXTENDED_ERROR = 'Lock not found or invalid token';
const MAX_JOB_DURATION_MS = 4_320_000_000_000_000; // = MAX_JOB_DELAY_MS
const MAX_JOB_ATTEMPTS = 2_147_483_647;
```

`JobOptionFields` uses the wire (`JobInput`) names, so a `PUSH` command, a `PUSHB`/flow
`JobInput` and an embedded input can be passed as they are. `prefix` is prepended to
every field name (cron templates use `jobOptions.`). `names` chooses how the fields
whose SDK name differs are reported: `WIRE_OPTION_NAMES` (`maxAttempts`, `dedup.ttl`,
`debounceTtl`) for TCP/HTTP commands, `CALLER_OPTION_NAMES` (`attempts`,
`deduplication.ttl`, `debounce.ttl`) for `Queue.add`/`addBulk`, FlowProducer flows and
`upsertJobScheduler` templates, so a message names the option the caller passed.
`upsertJobScheduler` reports a refused schedule (a template option no job can run
with, an invalid pattern, timezone or interval) as 2.9.10 did: embedded mode throws the
reason, TCP mode resolves `null` (boot code written for 2.9.10 checks for it).
`null`/`undefined` mean "not set" except where a value is required. Messages keep the
TCP format: `<field> must be a number`, `must be a finite number`, `must be an integer`,
`must be at least <min>`, `must be at most <max>`, `<field> is required`.
`src/infrastructure/server/protocol/validation.ts` re-exports these functions.

## Bounds

A numeric string is read as its number before the job-option rules and the
ChangeDelay/MoveToDelayed/ClearLogs/ChangePriority arguments below (`numberError`; the
engine then applies the coerced number). Command fields the handlers pass on as they
are (PULL/PULLB `timeout` and `count`, lease durations, `validateNumericField`) do not
coerce: a string there is still `must be a number`, as on 2.9.10. "Clamped" means a
larger finite value is accepted and stored as the maximum.

| Field (wire name)              | Rule                                                               |
| ------------------------------ | ------------------------------------------------------------------ |
| `priority`                     | any finite number; with `groupId`: `group.priority` integer 0..2,097,151 |
| `delay`                        | finite; a negative delay is a past run time (ready at once, ahead of later ready jobs); clamped to ±`MAX_JOB_DURATION_MS` |
| `ttl`, `timeout`               | finite, at least 0; clamped to `MAX_JOB_DURATION_MS`               |
| `stallTimeout`                 | finite (a negative value stalls at once, as 0 does)                |
| `maxAttempts` (`attempts`)     | any number, ±Infinity included; stored as `attemptCount`: 1 or less → 1 (runs once), a fraction rounds up, at most 2,147,483,647 |
| `backoff`                      | finite, at least 0 (the retry delay is capped by `maxDelay`, 1 h by default), or `{ type, delay?, maxDelay? }`: `delay` finite >= 0, 1000 ms when missing (createJob's default base; 2.9.10 lost such a job on a SQLite `NOT NULL`), `maxDelay` 0..86,400,000; `type` is free: `'fixed'` is fixed, any other value runs as exponential |
| `timestamp`                    | finite, within ±4,320,000,000,000,000 (so `timestamp + delay` is a valid date) |
| `stackTraceLimit`, `keepLogs`, `sizeLimit` | finite (stored as given; none is a resource bound in the engine) |
| `groupMaxSize`                 | positive safe integer (`group.maxSize must be a positive safe integer`) |
| `dedup.ttl`, `debounceTtl`     | finite (a negative window has already expired); clamped to `MAX_JOB_DURATION_MS` |
| `repeat.every`                 | positive finite; clamped to `MAX_JOB_DURATION_MS`                  |
| ChangeDelay/MoveToDelayed `delay` | required, finite; a negative delay is a past run time (ready at once); clamped to ±`MAX_JOB_DURATION_MS` (`delayArgument`) |
| `lockTtl`, ExtendLock(s) `duration`, JobHeartbeat `duration` | a finite number, any sign, passed through as on 2.9.10; omitted = default TTL (JobHeartbeat `0` = no TTL change); a string is refused |
| PULL/PULLB `timeout`           | finite, 0..60,000 (2.9.10's TCP rule)                              |
| Cron `repeatEvery`             | positive safe integer, at most `MAX_JOB_DURATION_MS`               |

Why these bounds:

- Each refusal guards real breakage: NaN never comes due (`runAt = now + NaN`), never
  expires (`expiresAt = now + NaN`), breaks the heap comparators and is dropped by
  SQLite's `NOT NULL`; an infinity breaks the comparators (`Infinity - Infinity` is NaN)
  or never expires; a negative `timeout` or `ttl` failed or expired the job at once. A
  `backoff` object without `delay` (which 2.9.10 lost on a SQLite `NOT NULL`) is
  admitted with the 1000 ms default base, on every path including job scheduler
  templates, so a re-upsert at boot never fails on it.
- Everything else 2.9.10 ran keeps its result. 2.9.10's TCP server bounded `priority`
  (integer ±1,000,000), `delay`/`ttl` (365 days), `timeout` (24 h), `maxAttempts`
  (1..1,000) and `backoff` (24 h), but embedded mode admitted all of them and ran them
  with a well-defined result (BullMQ's priority 2,097,152, `attempts: 0` or "retry
  forever", a 25 h timeout). The other fields were never range-checked over TCP. A
  client of either mode, and a 2.9.10 client against this server, keeps working.
- A negative job `delay` keeps 2.9.10's result on every path (embedded, TCP, HTTP,
  flows, cron templates, MCP, Cloud, PostgreSQL): `delay: runAt - Date.now()` turns
  negative once `runAt` has passed, and `createJob` stores `runAt = createdAt +
  jobRunDelay(delay)`, a run time in the past. The job is `waiting`, never `delayed`
  and never in the delayed index, and because the waiting queue (and the PostgreSQL
  claim order) sorts ready jobs by `runAt`, it goes AHEAD of ready jobs whose run time
  is later, as on 2.9.10 (a 2.11 candidate clamped it to now, which put it behind them).
  The public `job.delay` and `job.opts.delay` report 0 (`effectiveJobDelay`), as a job
  read back from the broker does. ChangeDelay/MoveToDelayed apply a negative delay the
  same way in the SQLite/embedded engine (`delayArgument`: `runAt = now + delay`); the
  PostgreSQL engine keeps its own 2.9.10 result, `now + max(0, delay)` (a negative
  ChangeDelay/MoveToDelayed makes the job ready now, behind earlier ready jobs): the
  engines differed on 2.9.10 and keep differing. The public `moveToDelayed(timestamp)`
  keeps 2.9.10's client-side `max(0, timestamp - now)`, so a past timestamp means "now"
  (a plain decimal string timestamp is read as its number, as 2.9.10's `-` coerced it).
  The past is bounded only by ±`MAX_JOB_DURATION_MS`.
- `attempts` of 0 or less (BullMQ's default is 0) ran the job exactly once on 2.9.10
  (`attempts < maxAttempts` is false after the first failure), so it is admitted and
  stored as 1; only NaN or a non-number is refused.
- Durations are honoured up to `MAX_JOB_DURATION_MS`, half the JavaScript Date range:
  timers are overflow-safe (`shared/timers.ts`), the processing deadline handles any
  timeout (`timeoutRule.ts`), and the PostgreSQL lease clamps its deadline. A longer
  duration is clamped rather than refused: both mean "never" in practice, and the
  clamped value keeps `timestamp + duration` a valid date and every PostgreSQL BIGINT
  column in range.
- `maxAttempts` is stored so that the attempts made never exceed it (the model
  invariant): `attempts: 0` (BullMQ's default) ran once on 2.9.10, so it is stored as 1;
  2.5 ran 3 attempts, so it is stored as 3. PostgreSQL keeps `max_attempts` as INTEGER.
- `priority` is any finite number. SQLite stores it as given; PostgreSQL's
  `bunqueue_jobs.priority` is an INTEGER, so the column (which only orders claims) gets
  it within the INTEGER range (`postgresPriorityColumn`; PostgreSQL rounds a fraction)
  while the payload keeps the exact value.
- A lease of any finite length is granted, as on 2.9.10: a 2.9.10 Worker with
  `lockDuration: 0` sends `lockTtl: 0`, and refusing it made every pull fail, which that
  Worker reads as an empty queue. NaN/Infinity (and a string, which `now + '5000'` turns
  into text) would never expire.
- Durations may be fractional (`0.1 * 3 * 1000` is `300.00000000000006`); the timeout
  scheduler rounds deadlines up rather than rejecting them.

## Engine guards

Validation covers every public path; internal callers (the `QueueManager` API used
directly, legacy cron templates, stored rows) are still made safe:

- `createJob` never stores NaN or a non-number in `createdAt`, `runAt`, `backoff`,
  `priority` or `maxAttempts`: it falls back to now / no delay / the defaults, so SQLite
  never drops the row. Infinity is kept (it is a valid "never" for these fields). A
  negative `delay` is stored as no delay (`effectiveJobDelay`, also used by the client
  to report the added job's `delay`).
- `isReady(job)` is `!(job.runAt > now)`, the complement of `isDelayed`, as every state
  view already classifies jobs: a NaN run time is ready, not "waiting" forever. This
  also removes a synchronous infinite loop in the group scheduler (promote, not ready,
  demote, promote...) that froze the process for a grouped NaN-delay job.
- `calculateBackoff` always returns a finite delay >= 0: a zero base retries at once
  for any attempt count (no `0 * 2^1024 = NaN`), the exponent is capped at 1023, a NaN
  or missing base uses the 1000 ms default, and an invalid stored `maxDelay` falls back
  to the 1-hour cap.
- The pull waiter only lets a next run time shorten its wait when it matures before the
  pull deadline: a NaN, infinite or far run time waits for a notification or the
  deadline instead of re-polling every ~1 ms (264 timers in a 300 ms pull before).
- `WaiterManager` arms `safeTimeout` (a wait above 2^31 - 1 ms no longer fires after
  ~1 ms; Infinity waits for a notification) and rejects a NaN timeout with a TypeError.
- `QueueManager.pull`, `pullWithLock`, `pullBatch` and `pullBatchWithLock` (the
  `bunqueue/queue` API, which 2.9.10 never validated nor capped) honour any `timeoutMs`
  (`pullTimeoutArgument`): a negative value, NaN or a non-number is no wait, as 2.9.10
  treated it; a wait above 60 s is honoured through the overflow-safe waiter timers, and
  Infinity holds the caller until a job comes or the signal aborts, as on 2.9.10. TCP
  and HTTP PULL/PULLB keep 2.9.10's 0..60,000 ms rule.
  A finite `lockTtl` is granted as given; NaN/Infinity throw.
- `isTimedOut(job, now)` derives from `processingDeadline` (`timeoutRule.ts`), the rule
  the broker's timeout scheduler and the Worker share: an absent, 0 or NaN timeout is no
  timeout, a fraction rounds the deadline up, and the deadline itself is due. It used to
  report `timeout: 0` as already timed out and the deadline millisecond as not due.

Job setters converge on `src/domain/job/mutations.ts`, applied by the `QueueManager`
methods every caller reaches (TCP and HTTP handlers through the top-level error reply,
embedded jobs, MCP, Cloud):

- `ChangePriority`: `priority` is any finite number, for grouped jobs too, and a
  missing one is 0 (`changePriority({ lifo: true })`, as BullMQ and 2.9.10 over TCP
  applied it; embedded 2.9.10 failed on a SQLite `NOT NULL`) (`validatePriorityChange`,
  `priorityChange`; a numeric string is its number). `lifo` is normalized to a boolean
  exactly as on PUSH (`1` is `true`, `0` is `false`); undefined/null keep the job's
  own. 2.9.10 applied all of these in both modes, and a 2.9.10 client ignores the reply,
  so refusing one left the job silently unchanged. Only a NaN, infinite or non-numeric
  priority is refused: it broke the heap comparator. Cloud `job:priority` follows the
  same rule (a missing priority is 0, as on 2.9.10). The broker's `PRIORITY_NOT_CHANGED_ERROR` reply
  (`Job not found or not in queue`) is "not changed" for clients, as embedded mode
  ignores a false result.
- `Progress`: `normalizeProgress` (see Setter outcomes): never refused, never NaN; the
  engine still clamps to [0, 100].
- `Update`: JSON serializable (`validateUpdatedJobData`), with no size limit, as on
  2.9.10 in both modes (an 11 MB `updateData` succeeded, and an embedded `add` never
  checked the data size either). TCP `PUSH`/`PUSHB` keep their 10 MB data limit.
- PUSH `lifo` is stored as a boolean (`createJob`): `1` and `true` each sorted before
  the other in the heap comparator.
- `ClearLogs`: `keepLogs` is applied as 2.9.10 applied it (`keepLogsArgument`): omitted,
  0 or a negative value clears every entry, a fraction keeps its whole part (`1.5` keeps
  1), a numeric string is its number (`'3'` keeps 3) and a count above the entries
  keeps them all. NaN and text are refused (`keepLogs must be a number`; NaN used to keep
  every entry silently). The `ClearLogs` handler checks it before the PostgreSQL
  `clearLogsDurable` branch too, and both engines apply `keepLogsArgument`.
  Every TCP client path reads the reply (`assertLogsCleared`), and the Job returned by
  `Queue.add` over TCP now forwards `keepLogs` (it dropped it, so `clearLogs(n)` cleared
  every entry).

Persisted cron definitions are not re-validated against these bounds on load, so an
older invalid template cannot block startup (every template 2.9.10 could run passes the
current rules anyway; an application re-upserting its schedulers at boot gets them
stored again). Instead `assertPersistedCronsSupported`
logs one warning per definition at load (`cronTemplateError`, shared with `addCron`):
`Persisted cron "<name>" has an invalid job template: <problem>. It still runs with its
stored values; re-add it with valid options to fix it.`

A row persisted before these bounds with `run_at = ±Infinity` (or any value beyond the
Date range) is recovered as delayed forever: it never spins a waiter, it is listed
under `delayed`, and `promote`/`promoteJobs` make it processable. SQLite cannot store a
NaN `run_at` (`NOT NULL`), so such a job was dropped at insert time and cannot be
recovered.

## Tests

- `test/repro-job-options-parity.test.ts`: embedded vs TCP `add`/`addBulk`, same
  messages, boundary values accepted.
- `test/repro-job-options-commands.test.ts`: ChangeDelay, MoveToDelayed, PULL/PULLB
  `lockTtl`, ExtendLock(s), JobHeartbeat, Cron, HTTP, and the embedded methods.
- `test/repro-job-options-engine-guards.test.ts`: NaN run time, grouped NaN hang
  (child process), persisted defaults, `calculateBackoff`, waiter guards, legacy
  Infinity row.
- `test/repro-job-options-flow.test.ts`: flows use the same messages as `Queue.add`.
- `test/repro-job-options-autobatch.test.ts`: `autoBatch` validation and the safe
  batch window timer.
- `test/repro-job-options-job-methods.test.ts`: Worker, FlowProducer and DLQ job
  `extendLock`/`changeDelay`/`moveToDelayed`, both modes.
- `test/repro-job-options-engine-entry.test.ts`: `isTimedOut` and `QueueManager` pull
  timeouts.
- `test/repro-job-options-http.test.ts`: strict query numbers and full PUSH forwarding.
- `test/repro-job-options-mcp.test.ts`: MCP data limit and legacy date guards.
- `test/repro-job-options-cron-load.test.ts`: the persisted-template warning.
- `test/repro-job-options-setters.test.ts`: ChangePriority (plain and grouped, both
  modes), Worker progress and update size, Cloud `job:priority`, PUSH `lifo`.
- `test/repro-job-options-clear-logs.test.ts`: `keepLogs` on Queue, job and Worker
  paths in both modes, and `keepLogs` forwarding over TCP.
- `test/repro-job-options-setter-outcomes.test.ts`: the setter outcome table for Queue,
  Queue jobs, FlowProducer jobs and DLQ jobs, plus object and invalid progress, in both
  modes.
- `test/repro-job-options-negative-delay.test.ts`: a negative `delay` is a `waiting`
  job pulled at once, ahead of later ready jobs (`runAt === createdAt + delay`, empty
  delayed index) through
  embedded and TCP `add`/`addBulk`, flows, HTTP `POST /queues/:q/jobs` and `/jobs/bulk`,
  MCP `add_job`/`add_jobs_bulk`/`add_flow`/`add_cron` and Cloud `job:push`; NaN,
  ±Infinity and non-numbers are still rejected.
- 2.9.10 compatibility (`test/repro-compat-job-*.test.ts`):
  `options-add` (every option value 2.9.10 ran, both modes, addBulk, defaults, repeat,
  flows, caller-named errors), `wire` (the exact commands a 2.9.10 client sends: PULL
  `lockTtl` 0, lease durations, PUSH/PUSHB fields, Progress, ChangePriority, ClearLogs,
  ChangeDelay/MoveToDelayed, Update, Cron), `commands` (job methods in a processor and
  on queued jobs, both modes), `scheduler` (job scheduler templates, defaults, fired
  jobs, Simple Mode), `http` (2.9.10's POST whitelist and GET parsing),
  `queue-manager` (the direct API), `pg-lease` (PostgreSQL renewal caps),
  `past-run-time` (a negative delay or ChangeDelay/MoveToDelayed keeps its past run time
  and order in both modes, PostgreSQL keeps a past job `delay` and clamps a negative
  ChangeDelay to now as on 2.9.10, `moveToDelayed('<epoch ms>')` is coerced,
  `attempts: -1` runs once, direct pull waits are not capped, a stored ±Infinity timeout
  is no timeout), `priority-backoff` (ChangePriority with a non-boolean `lifo` or no priority, and
  `backoff` without `delay`, over the wire and in both modes) and `scheduler-reply`
  (`upsertJobScheduler` resolves `null` over TCP and throws embedded on a refusal).
