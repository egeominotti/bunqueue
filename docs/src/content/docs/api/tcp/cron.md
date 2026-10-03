---
title: 'TCP Cron Commands: Schedules on the Wire'
description: 'bunqueue TCP cron commands: create or update a cron or fixed-interval schedule with timezone, dedup and per-job options, then list, read and delete schedules.'
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/api/tcp/cron.png
---

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">api reference · tcp · cron</span>
  <h1 class="bq-hero-h1 bq-bench-h1">Schedules, <em>on the wire.</em></h1>
  <p class="bq-hero-sub">Create or update cron and fixed-interval schedules with timezones, deduplication and per-job options, then list, read and delete them by name.</p>
</div>

Part of the [TCP protocol reference](/api/tcp/), which describes the framing, authentication, pipelining and response format that every command on this page uses.

## Cron Commands

### Cron

Create or update a cron/repeating job schedule.

**Request:**

```typescript
{
  cmd: 'Cron',
  name: string,             // Unique cron job name
  jobName?: string,         // First-class name assigned to spawned jobs
  queue: string,            // Target queue
  data: any,                // Job data payload
  schedule?: string,        // Cron expression (e.g., '*/5 * * * *')
  repeatEvery?: number,     // Positive safe-integer ms (schedule wins if both exist)
  priority?: number,        // Job priority
  maxLimit?: number,        // Max executions
  timezone?: string,        // IANA timezone (e.g., 'Europe/Rome', 'America/New_York')
  uniqueKey?: string,       // Deduplication key for cron-spawned jobs
  dedup?: { ttl?: number, extend?: boolean, replace?: boolean }, // Dedup options for spawned jobs
  skipMissedOnRestart?: boolean, // Skip missed runs on restart instead of executing them (default true)
  immediately?: boolean,    // Fire once on creation, then continue on schedule (default false)
  skipIfNoWorker?: boolean, // Skip a tick when no worker is registered (default false)
  preventOverlap?: boolean, // Skip a tick while the previous run is still pending/active (default true)
  jobOptions?: {            // Per-job options applied to every generated job
    maxAttempts?: number,
    backoff?: number | { type: 'fixed' | 'exponential', delay: number, maxDelay?: number }, // not validated here: an unusable maxDelay is ignored (1 h cap)
    timeout?: number,
    delay?: number,
    stallTimeout?: number,
    removeOnComplete?: boolean,
    removeOnFail?: boolean
  }
}
```

**Response:**

```typescript
{
  ok: true,
  cron: {
    name: string,
    jobName: string,
    queue: string,
    schedule: string | null,
    repeatEvery: number | null,
    nextRun: number,
    executions: number,
    maxLimit: number | null,
    timezone: string | null,
    priority: number
  }
}
```

---

### CronDelete

Delete a cron job schedule by name.

**Request:**

```typescript
{ cmd: 'CronDelete', name: string }
```

**Response:**

```typescript
{
  ok: true;
}
```

---

### CronList

List all registered cron job schedules.

**Request:**

```typescript
{
  cmd: 'CronList';
}
```

**Response:**

```typescript
{
  ok: true,
  crons: Array<{
    name: string,
    jobName: string,
    queue: string,
    schedule: string | null,
    repeatEvery: number | null,
    nextRun: number,
    executions: number,
    maxLimit: number | null,
    timezone: string | null,
    priority: number
  }>
}
```

---

### CronGet

Get a single cron job by name.

**Request:**

```typescript
{ cmd: 'CronGet', name: string }
```

**Response:**

```typescript
{
  ok: true,
  cron: {
    name: string,
    jobName: string,
    queue: string,
    schedule: string | null,
    repeatEvery: number | null,
    nextRun: number,
    executions: number,
    maxLimit: number | null,
    timezone: string | null,
    priority: number
  }
}
```

Returns an error if the cron job is not found.
