---
title: 'TCP Control Commands: Jobs, Queues, Limits'
description: 'bunqueue TCP control commands: cancel, update, promote and discard jobs, pause, drain and clean queues, and set rate, concurrency, group and per-queue config.'
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/api/tcp/control.png
---

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">api reference · tcp · control</span>
  <h1 class="bq-hero-h1 bq-bench-h1">Steer jobs, queues <em>and limits.</em></h1>
  <p class="bq-hero-sub">Change individual jobs, pause, drain, clean and obliterate whole queues, and set rate limits, concurrency caps, job group controls and per-queue stall and DLQ configuration.</p>
</div>

Part of the [TCP protocol reference](/api/tcp/), which describes the framing, authentication, pipelining and response format that every command on this page uses.

## Control Commands

### Cancel

Cancel a waiting or delayed job.

**Request:**

```typescript
{ cmd: 'Cancel', id: string }
```

**Response:**

```typescript
{
  ok: true;
}
```

---

### Progress

Update the progress of an active job.

**Request:**

```typescript
{
  cmd: 'Progress',
  id: string,
  progress: number,       // 0-100
  message?: string        // Optional progress message
}
```

`progress` is stored as in 2.9.10 and never refused: a number is clamped to 0-100 (NaN
is 0); a numeric string, a boolean or null is its `Number(...)` (`"50"` is 50, `true` is
1); other text is 0 with the text as the `message` when none is given. Clients send
object progress as `0` with its JSON as the `message`.

**Response:**

```typescript
{
  ok: true;
}
```

---

### Update

Update the data payload of an existing job.

**Request:**

```typescript
{
  cmd: 'Update',
  id: string,
  data: any              // New job data
}
```

`data` must be JSON serializable (`Job data must be JSON serializable`). Unlike `PUSH`,
an update has no size limit, as in 2.9.10.

**Response:**

```typescript
{
  ok: true;
}
```

---

### ChangePriority

Change the priority of a queued job.

**Request:**

```typescript
{
  cmd: 'ChangePriority',
  id: string,
  priority: number,
  lifo?: boolean         // Tie-break ordering among same-priority jobs
}
```

`priority` can be any finite number, for grouped jobs too (as in 2.9.10; a numeric
string counts as its number); a missing `priority` is 0 (BullMQ's
`changePriority({ lifo: true })`). `lifo`, when given, is made a boolean exactly as on
`PUSH` (`1` is `true`, `0` is `false`). NaN, an infinity or a non-number fails
(`priority must be a finite number`, `priority must be a number`) and leaves the job
unchanged; a job that is not queued fails with `Job not found or not in queue`,
which the client SDKs treat as "not changed", like embedded mode.

**Response:**

```typescript
{
  ok: true;
}
```

---

### Promote

Move a delayed job to the waiting state immediately.

**Request:**

```typescript
{ cmd: 'Promote', id: string }
```

**Response:**

```typescript
{
  ok: true;
}
```

---

### MoveToDelayed

Move an active job back to the delayed state.

**Request:**

```typescript
{
  cmd: 'MoveToDelayed',
  id: string,
  delay: number,         // Delay in ms from now (required, finite; negative = past run time)
  token?: string         // Required when the active job has a lock
}
```

A missing or non-finite `delay` fails the command (`delay is required`,
`delay must be a finite number`, ...) and leaves the job unchanged. As in 2.9.10, a
negative `delay` makes the job ready at once with a past run time (ahead of later ready
jobs; a PostgreSQL broker uses "now", as on 2.9.10) and a very large one is applied (clamped at
about 136,900 years).

**Response:**

```typescript
{
  ok: true;
}
```

---

### Discard

Discard a job by moving it to the dead-letter queue.

**Request:**

```typescript
{ cmd: 'Discard', id: string, token?: string }
```

When the job has an active lease, `token` must match the current delivery
token. For waiting or otherwise unlocked jobs, the field may be omitted for an
administrative discard.

**Response:**

```typescript
{
  ok: true;
}
```

---

### WaitJob

Wait for a job to complete. This is event-driven (no polling). Returns immediately if the job is already completed.

**Request:**

```typescript
{
  cmd: 'WaitJob',
  id: string,
  timeout?: number       // Max wait time in ms (default: 30000, max: 600000)
}
```

**Response:**

```typescript
{ ok: true, completed: boolean, result?: any }
```

---

### Pause

Pause a queue. Workers will stop pulling new jobs.

**Request:**

```typescript
{ cmd: 'Pause', queue: string }
```

**Response:**

```typescript
{
  ok: true;
}
```

---

### Resume

Resume a paused queue.

**Request:**

```typescript
{ cmd: 'Resume', queue: string }
```

**Response:**

```typescript
{
  ok: true;
}
```

---

### IsPaused

Check whether a queue is currently paused.

**Request:**

```typescript
{ cmd: 'IsPaused', queue: string }
```

**Response:**

```typescript
{ ok: true, paused: boolean }
```

---

### Drain

Remove all waiting and delayed jobs from a queue. Active jobs are not affected.

**Request:**

```typescript
{ cmd: 'Drain', queue: string }
```

**Response:**

```typescript
{ ok: true, count: number }  // Number of jobs removed
```

---

### Obliterate

Remove all data for a queue (all jobs in all states).

**Request:**

```typescript
{ cmd: 'Obliterate', queue: string }
```

**Response:**

```typescript
{
  ok: true;
}
```

---

### Clean

Remove jobs older than a grace period, optionally filtered by state.

**Request:**

```typescript
{
  cmd: 'Clean',
  queue: string,
  grace: number,         // Grace period in ms - jobs older than this are removed
  state?: string,        // 'waiting'/'delayed'/'prioritized'/'paused' (queued jobs, the default), 'completed', or 'failed'
  limit?: number         // Max jobs to remove (default: 1000)
}
```

**Response:**

```typescript
{ ok: true, count: number, ids: string[] }  // IDs of the removed jobs
```

---

### ListQueues

List the names of all known queues.

**Request:**

```typescript
{
  cmd: 'ListQueues';
}
```

**Response:**

```typescript
{ ok: true, queues: string[] }  // Queue names
```

For per-queue counts use `GetJobCounts` per queue, or the HTTP `GET /queues/summary` endpoint.

---

## Rate Limiting Commands

### RateLimit

Set a rate limit on a queue: `limit` jobs per `duration` ms (default 1000, so jobs per second).

**Request:**

```typescript
{
  cmd: 'RateLimit',
  queue: string,
  limit: number,         // Max jobs per window
  duration?: number,     // Window in ms (default 1000)
  ttl?: number           // Auto-expiry in ms: the server clears the limit itself
}
```

Invalid `duration` or `ttl` values (non-finite or not positive) fall back to the defaults (1 second window, permanent limit) instead of failing. Servers older than 2.8.35 ignore both optional fields.

**Response:**

```typescript
{
  ok: true;
}
```

---

### RateLimitClear

Remove the rate limit from a queue.

**Request:**

```typescript
{ cmd: 'RateLimitClear', queue: string }
```

**Response:**

```typescript
{
  ok: true;
}
```

---

### SetConcurrency

Set a concurrency limit on a queue (max concurrent active jobs).

**Request:**

```typescript
{
  cmd: 'SetConcurrency',
  queue: string,
  limit: number
}
```

**Response:**

```typescript
{
  ok: true;
}
```

---

### ClearConcurrency

Remove the concurrency limit from a queue.

**Request:**

```typescript
{ cmd: 'ClearConcurrency', queue: string }
```

**Response:**

```typescript
{
  ok: true;
}
```

---

### GetQueueLimits

Read the live rate/concurrency configuration and saturation state.

```typescript
{ cmd: 'GetQueueLimits', queue: string, maxJobs?: number }

{
  ok: true,
  data: {
    limits: {
      rateLimit: { max: number, duration: number } | null,
      rateLimitTtl: number,          // -2 when no rate limit exists
      concurrencyLimit: number | null,
      maxed: boolean
    }
  }
}
```

---

### Job group controls and getters

Group depth excludes active jobs and includes waiting, prioritized and delayed
jobs. Every response below is wrapped in `data`:

```typescript
{ cmd: 'GetGroupJobsCount', queue, groupId }
// -> { ok: true, data: { count: number } }

{ cmd: 'GetGroupsJobsCount', queue, maxCount? }
// -> { ok: true, data: { count: number } }

{ cmd: 'GetGroupActiveCount', queue, groupId }
// -> { ok: true, data: { count: number } }

{ cmd: 'SetGroupRateLimit', queue, groupId, max, duration }
{ cmd: 'GetGroupRateLimit', queue, groupId }
// -> { ok: true, data: { limit: { max, duration } | null } }

{ cmd: 'RemoveGroupRateLimit', queue, groupId }
// -> { ok: true, data: { removed: 0 | 1 } }

{ cmd: 'GetGroupRateLimitTtl', queue, groupId, maxJobs? }
// -> { ok: true, data: { ttl: number } }

{ cmd: 'SetGroupConcurrency', queue, groupId, concurrency }
{ cmd: 'GetGroupConcurrency', queue, groupId }
// -> { ok: true, data: { concurrency: number | null } }

{ cmd: 'RemoveGroupConcurrency', queue, groupId }
// -> { ok: true, data: { removed: 0 | 1 } }

{ cmd: 'PauseGroup', queue, groupId }
// -> { ok: true, data: { changed: boolean } }
{ cmd: 'ResumeGroup', queue, groupId }
// -> { ok: true, data: { changed: boolean } }
{ cmd: 'IsGroupPaused', queue, groupId }
// -> { ok: true, data: { paused: boolean } }
{ cmd: 'RateLimitGroup', queue, groupId, duration }
// -> { ok: true }
```

Group IDs are non-empty strings of at most 256 characters. `max`, `duration`,
and `concurrency` must be positive safe integers. Stored overrides affect a
claim only when `PULL`/`PULLB` carries the corresponding `group` default.
Pause blocks only new claims from that group. `RateLimitGroup` installs an
immediately effective manual deadline even when the Worker has no group-rate
default.

---

### Deduplication Introspection

```typescript
{ cmd: 'GetDeduplicationJobId', queue: string, deduplicationId: string }
// -> { ok: true, data: { jobId: string | null } }

{ cmd: 'RemoveDeduplicationKey', queue: string, deduplicationId: string }
// -> { ok: true, data: { count: number } }

{ cmd: 'RemoveJobDeduplicationKey', id: string }
// -> { ok: true, data: { removed: boolean } }
```

The job-owned form removes a key only when the requested job is still its
registered owner.

---

### MoveToWaitingChildren

```typescript
{ cmd: 'MoveToWaitingChildren', id: string, token?: string }
// -> { ok: true, data: { moved: true } }
```

The job must be active. The transition releases its active resources and
persists the parked state. If the job has a lock, `token` must match it.

---

## Queue Config Commands

### SetStallConfig / GetStallConfig

Per-queue stall detection configuration. Numeric fields: `stallInterval`, `maxStalls`, `gracePeriod` (numeric strings are coerced, non-numeric values are dropped).

**Request:**

```typescript
{ cmd: 'SetStallConfig', queue: string, config: { stallInterval?: number, maxStalls?: number, gracePeriod?: number } }
{ cmd: 'GetStallConfig', queue: string }
```

**Response:** `{ ok: true }` for set, `{ ok: true, config: {...} }` for get.

### SetDlqConfig / GetDlqConfig

Per-queue DLQ configuration. Numeric fields: `autoRetryInterval`, `maxAutoRetries`, `maxAge`, `maxEntries`.

**Request:**

```typescript
{ cmd: 'SetDlqConfig', queue: string, config: { autoRetry?: boolean, autoRetryInterval?: number, maxAutoRetries?: number, maxAge?: number | null, maxEntries?: number } }
{ cmd: 'GetDlqConfig', queue: string }
```

**Response:** `{ ok: true }` for set, `{ ok: true, config: {...} }` for get.
