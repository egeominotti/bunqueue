---
title: 'TCP Job Commands: PUSH, PULL, ACK, FAIL'
description: 'bunqueue TCP job commands: PUSH, PUSHB, PUSHF, PULL, PULLB, ACK, ACKB and FAIL, plus job logs, lock extension and the remaining job transitions.'
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/api/tcp/jobs.png
---

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">api reference · tcp · jobs</span>
  <h1 class="bq-hero-h1 bq-bench-h1">Push, pull, <em>settle.</em></h1>
  <p class="bq-hero-sub">Add jobs one at a time, in batches or as an atomic flow graph, claim them with optional locks, and acknowledge or fail them. Job logs, lock extension and the remaining job transitions follow.</p>
</div>

Part of the [TCP protocol reference](/api/tcp/), which describes the framing, authentication, pipelining and response format that every command on this page uses.

## Core Commands

### PUSH

Add a single job to a queue.

**Request:**

```typescript
{
  cmd: 'PUSH',
  queue: string,          // Queue name (required, max 256 chars, alphanumeric/underscore/dash/dot/colon)
  name: string,           // Job name metadata (required for protocol v3 clients)
  data: any,              // Untouched user payload (required, max 10 MB)
  priority?: number,      // Ungrouped: any finite number, higher first. With groupId: 0 first, then ascending (0..2097151)
  delay?: number,         // Delay in ms before processing (default: 0; negative = ready, past run time)
  maxAttempts?: number,   // Max attempts (default: 3; 1 or less runs once, fraction rounds up, max 2147483647)
  backoff?: number,       // Retry backoff delay in ms (default: 1000; each retry capped at 1 h or maxDelay)
  ttl?: number,           // Time-to-live in ms (>= 0)
  timeout?: number,       // Processing timeout in ms (>= 0; 0 = none)
  uniqueKey?: string,     // Deduplication key
  jobId?: string,         // Custom job ID (idempotent)
  dependsOn?: string[],   // Job IDs this job depends on
  tags?: string[],        // Metadata tags
  groupId?: string,       // Job group identifier
  groupMaxSize?: number,  // Positive safe-integer pending-depth admission cap
  lifo?: boolean,         // Last-in-first-out (default: false)
  removeOnComplete?: boolean, // Auto-remove on completion (default: false)
  removeOnFail?: boolean,     // Auto-remove on failure (default: false)
  durable?: boolean,      // SQLite: bypass write buffer; PostgreSQL is already transactional
  repeat?: {              // Repeat configuration
    every?: number,       //   Repeat interval in ms
    pattern?: string,     //   Cron expression (alternative to every)
    limit?: number,       //   Max repetitions
    count?: number,       //   Current count
    startDate?: number,   //   Don't fire before this timestamp
    endDate?: number,     //   Don't fire after this timestamp
    tz?: string,          //   IANA timezone for pattern
    immediately?: boolean //   Fire once on creation
  },
  // Flow / parent-child (used by FlowProducer):
  parentId?: string,      // Parent job ID
  childrenIds?: string[], // Child job IDs (flow parent)
  failParentOnFailure?: boolean,
  removeDependencyOnFailure?: boolean,
  ignoreDependencyOnFailure?: boolean,
  continueParentOnFailure?: boolean,
  // Advanced options:
  stallTimeout?: number,  // Stall detection timeout in ms (finite)
  stackTraceLimit?: number, // Cap on stored stack trace lines (finite)
  keepLogs?: number,      // BullMQ metadata, stored as given (finite)
  sizeLimit?: number,     // BullMQ metadata, stored as given (finite)
  dedup?: { ttl?: number, extend?: boolean, replace?: boolean }, // Dedup options (uniqueKey carries the id); ttl finite
  debounceId?: string,    // Debounce identifier
  debounceTtl?: number,   // Debounce window in ms (finite)
  timestamp?: number      // Explicit creation timestamp (within ±4,320,000,000,000,000)
}
```

Every numeric option must be a finite number (a numeric string such as `"3"` counts as
its number; `repeat.every` must also be positive); `timeout` and `ttl`
cannot be negative; `maxAttempts` of 1 or less runs the job once and `Infinity` is
stored as 2,147,483,647. A
violation fails the command with `{ ok: false, error }` naming the field, for example
`timeout must be at least 0` or `delay must be a finite number`. Every value 2.9.10
accepted in either mode is accepted with its 2.9.10 result; durations above about
136,900 years (4.32e15 ms) are clamped. Durations may be fractional. A negative `delay`
keeps its past run time, as in 2.9.10: the job is ready at once (never `delayed`) and
runs ahead of ready jobs with a later run time. Embedded `Queue.add`, `addBulk`, flows and job schedulers apply the same
rules (their messages name the SDK option, such as `attempts`).

The `backoff` field also accepts an object form: `{ type: 'fixed' | 'exponential', delay?: number, maxDelay?: number }` (any other `type` runs as exponential, as in 2.9.10). `maxDelay` caps each computed retry delay for that job (default: 1 hour when omitted). A missing `delay` is the 1000 ms default base; a given one must be a finite number of at least 0; `maxDelay` must be a finite number between 0 and 86,400,000 ms (1 day); `maxDelay: null` is treated as omitted, and any other invalid value fails the command. The same rule applies to every job in `PUSHB` and `PUSHF`.

**Response:**

```typescript
{ ok: true, id: string }  // The generated job ID (UUIDv7)
```

---

### PUSHB

Batch push multiple jobs to a queue.

**Request:**

```typescript
{
  cmd: 'PUSHB',
  queue: string,
  jobs: Array<{
    name: string,
    data: any,
    priority?: number,
    delay?: number,
    maxAttempts?: number,
    backoff?: number,
    ttl?: number,
    timeout?: number,
    uniqueKey?: string,
    customId?: string,
    dependsOn?: string[],
    tags?: string[],
    groupId?: string,
    groupMaxSize?: number,
    lifo?: boolean,
    removeOnComplete?: boolean,
    removeOnFail?: boolean,
    durable?: boolean,
    // ...and every other PUSH option (stallTimeout, timestamp, dedup, ...)
  }>
}
```

Each job is validated with the same rules as `PUSH` (option bounds and
`dependsOn` existence). A `dependsOn` entry may also reference the `customId`
of any job in the same batch, so order-independent intra-batch chains work. On
violation the whole batch is rejected with an error naming the offending index
(`jobs[i]: ...`).

When `groupId` is present, `priority` is the intra-group priority and must be an
integer from `0` through `2,097,151`; lower values run first. `groupMaxSize`
makes pending-depth admission atomic. If one member would exceed its group cap,
the complete `PUSHB` is rejected without partial writes.

**Response:**

```typescript
{ ok: true, ids: string[] }  // Array of generated job IDs
```

---

### PUSHF

Atomically commit a fully resolved, potentially multi-queue FlowProducer graph.
This is the command used by the Bun package and all six current official SDKs.
Previously published clients may still compose legacy `PUSH`/`UpdateParent`
calls.

**Request:**

```typescript
{
  cmd: 'PUSHF',
  jobs: Array<{
    id: string,             // Final ID; non-empty, no colon
    queue: string,
    input: {
      name: string,
      data: unknown,        // untouched user payload
      dependsOn?: string[],
      parentId?: string,
      childrenIds?: string[],
      groupId?: string,
      priority?: number,       // with groupId: 0 first, then ascending
      groupMaxSize?: number,
      // supported ordinary scheduling/retry/failure options
    }
  }>
}
```

The complete graph is validated before mutation: strict runtime types,
duplicate/missing/asymmetric edges, cycles, policy conflicts, 10,000 jobs,
10 MB per job and 64 MB aggregate data. With configured SQLite, all job rows
commit in one immediate transaction before any leaf becomes visible. In
PostgreSQL mode commits the graph, dependency edges, and ordered durable events
in one database transaction before publication. In memory-only mode,
publication is still atomic but not crash-durable.

**Response:**

```typescript
{ ok: true, data: { jobs: Job[] } }
```

The returned array has exactly one authoritative committed snapshot per input
ID. Any validation, ownership or persistence error returns `{ ok: false,
error }` and publishes no job.

---

### PULL

Pull the next available job from a queue. Supports optional long polling and lock-based ownership.

**Request:**

```typescript
{
  cmd: 'PULL',
  queue: string,
  timeout?: number,    // Long poll timeout in ms (0-60000, default: 0)
  owner?: string,      // Client identifier for lock-based pull
  lockTtl?: number,    // Lock TTL in ms (default: 30000; any finite number, as in 2.9.10)
  detach?: boolean,    // Don't auto-release the job when this connection closes (CLI usage; ignored with owner)
  group?: { concurrency?: number, limit?: { max: number, duration: number } }
}
```

**Response (without owner):**

```typescript
{ ok: true, job: Job | null }
```

**Response (with owner, includes lock token):**

```typescript
{ ok: true, job: Job | null, token: string | null }
```

The `token` must be passed to `ACK` or `FAIL` to verify ownership.

---

### PULLB

Batch pull multiple jobs from a queue.

**Request:**

```typescript
{
  cmd: 'PULLB',
  queue: string,
  count: number,       // Number of jobs to pull (1-1000)
  timeout?: number,    // Long poll timeout in ms (0-60000, default: 0), with or without owner
  owner?: string,      // Client identifier for lock-based pull
  lockTtl?: number,    // Lock TTL in ms (default: 30000; any finite number, as in 2.9.10)
  group?: { concurrency?: number, limit?: { max: number, duration: number } }
}
```

A `lockTtl` that is not a finite number (`lockTtl must be a number`, `lockTtl must be a
finite number`) fails the command before any job is claimed; NaN or an infinity would be
a lease that never expires. Every finite value is granted as given, as in 2.9.10 (a
2.9.10 Worker with `lockDuration: 0` sends `lockTtl: 0`).

**Response (without owner):**

```typescript
{ ok: true, jobs: Job[] }
```

**Response (with owner, includes lock tokens):**

```typescript
{ ok: true, jobs: Job[], tokens: string[] }
```

---

### ACK

Acknowledge a job as completed.

**Request:**

```typescript
{
  cmd: 'ACK',
  id: string,           // Job ID
  result?: any,         // Optional result data
  token?: string,       // Lock token (required if pulled with owner)
  removeOnComplete?: boolean // true: remove the job after completion for this call
}
```

**Response:**

```typescript
{
  ok: true;
}
```

If an exact timeout or retired cron generation already finalized before the
ACK claimed it, the response is a successful no-op rather than a retryable
transport error:

```typescript
{ ok: true, data: { applied: false, reason: 'already-finalized' } }
```

---

### ACKB

Batch acknowledge multiple jobs.

**Request:**

```typescript
{
  cmd: 'ACKB',
  ids: string[],          // Job IDs
  results?: any[],        // Optional results (same order as ids; if provided, length must match ids)
  tokens?: string[]       // Lock tokens (same order/length as ids; required for leased jobs)
}
```

The broker validates every token before completing any item. A missing or
incorrect token rejects the whole batch and leaves all jobs, locks, and results
unchanged.

**Response:**

```typescript
{
  ok: true;
}
```

A timeout may win after the batch's lease preflight. Live positions still
apply and the broker reports the exact ignored input positions in order:

```typescript
{
  ok: true,
  data: {
    ignoredIds: ['job-id'],
    ignoredIndices: [2]
  }
}
```

Clients must use `ignoredIndices` when IDs repeat. Wrong/missing tokens and
ordinary missing/completed jobs remain errors.

---

### FAIL

Mark a job as failed. The job will be retried with exponential backoff if it has remaining attempts, otherwise it is moved to the dead-letter queue.

**Request:**

```typescript
{
  cmd: 'FAIL',
  id: string,            // Job ID
  error?: string,        // Error message
  stack?: string[],      // Failure stack trace lines, persisted server-side, capped at job.stackTraceLimit (#74)
  unrecoverable?: boolean, // Skip all remaining retries and fail terminally (straight to DLQ)
  token?: string,        // Lock token (required if pulled with owner)
  removeOnFail?: boolean // true: remove the job on terminal failure for this call
}
```

The optional `stack` is stored on the job and surfaced by `GetJob` and on DLQ entries, so a failed job's stack trace survives a restart.

**Response:**

```typescript
{
  ok: true;
}
```

An exact late generation uses the same successful no-op envelope as `ACK`:

```typescript
{ ok: true, data: { applied: false, reason: 'already-finalized' } }
```

---

## Log Commands

### AddLog

Add a log entry to a job.

**Request:**

```typescript
{
  cmd: 'AddLog',
  id: string,            // Job ID
  message: string,       // Log message
  level?: 'info' | 'warn' | 'error'  // Log level (default: 'info')
}
```

**Response:**

```typescript
{ ok: true, data: { added: true } }
```

---

### GetLogs

Get all log entries for a job.

**Request:**

```typescript
{ cmd: 'GetLogs', id: string, start?: number, end?: number }  // start/end: inclusive pagination indexes
```

**Response:**

```typescript
{ ok: true, data: { logs: Array<{ message: string, level: string, timestamp: number }>, count: number } }
```

`count` is the total number of stored log entries (before pagination). Logs are capped at 100 entries per job.

---

## Lock Commands

### ExtendLock

Extend the lock TTL on an active job (lock-based processing).

**Request:**

```typescript
{ cmd: 'ExtendLock', id: string, duration: number, token?: string }
```

`duration` is the new lease length from now: any finite number, applied as given (as in
2.9.10; 0 or less ends the lease now). An omitted `duration` keeps the lease's current
TTL; NaN, an infinity or a non-number fails with `duration must be ...` and leaves the
lease unchanged.

**Response:** `{ ok: true }` or `{ ok: false, error: 'Lock not found or invalid token' }`

---

### ExtendLocks

Batch variant of `ExtendLock` (positional arrays, same order).

**Request:**

```typescript
{ cmd: 'ExtendLocks', ids: string[], tokens: string[], durations: number[] }
```

Each duration follows the `ExtendLock` rule. One invalid entry fails the whole
command with `durations[i]: duration must be ...` before any lease is extended.

**Response:**

```typescript
{ ok: true, count: number }  // Number of locks successfully extended
```

---

## More Job Commands

### ChangeDelay

Change the delay of a delayed job (recomputes `runAt`).

**Request:** `{ cmd: 'ChangeDelay', id: string, delay: number, token?: string }`

`delay` (ms from now) is required and must be a finite number (a numeric string counts
as its number). As with the `PUSH` `delay` and as in 2.9.10, a negative value makes the
job ready at once with a past run time (ahead of later ready jobs); a PostgreSQL broker
applies it as "now", as it did on 2.9.10. NaN or an infinity fails the command (`delay must be a finite number`).

`token` is required when the job is active and currently leased. Worker
processor Job objects forward their current delivery token automatically;
unlocked administrative transitions may omit it.

**Response:** `{ ok: true }`

---

### MoveToWait

Move a job back to `waiting`, dispatching by current state: `active` is released back to the queue, `delayed` is promoted, `failed` is retried from the DLQ, `waiting`/`prioritized` is a no-op success.

**Request:** `{ cmd: 'MoveToWait', id: string, token?: string }`

**Response:** `{ ok: true }`

For an active locked job, `token` is required and must match the current lease.
An active job without a lock can still be moved administratively.

---

### PromoteJobs

Promote all (or up to `count`) delayed jobs in a queue to waiting.

**Request:** `{ cmd: 'PromoteJobs', queue: string, count?: number }`

**Response:** `{ ok: true, count: number }`

---

### ClearLogs

Clear a job's log entries, optionally keeping the most recent N.

**Request:** `{ cmd: 'ClearLogs', id: string, keepLogs?: number }`

`keepLogs` is the number of most recent entries to keep, applied as in 2.9.10: omitted,
`0` or a negative value clears every entry, a fraction keeps its whole part (`2.5` keeps
2), a numeric string counts as its number and a value above the entry count keeps them
all. NaN or text fails with `keepLogs must be a number` and leaves the logs unchanged.

**Response:** `{ ok: true }`

---

### SetWebhookEnabled

Enable or disable a webhook without deleting it.

**Request:** `{ cmd: 'SetWebhookEnabled', id: string, enabled: boolean }`

**Response:** `{ ok: true }` or `{ ok: false, error: 'Webhook not found' }`

---

### CompactMemory

Trigger internal memory compaction.

**Request:** `{ cmd: 'CompactMemory' }`

**Response:** `{ ok: true }`
