---
title: 'TCP Query Commands: Jobs, States, Counts'
description: 'bunqueue TCP query commands: read a job by ID or custom ID, its state, result and progress, list jobs with filters and paging, and count by state or priority.'
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/api/tcp/queries.png
---

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">api reference · tcp · queries</span>
  <h1 class="bq-hero-h1 bq-bench-h1">Ask about a job, <em>change nothing.</em></h1>
  <p class="bq-hero-sub">Read jobs by internal or custom ID, their state, result and progress, list them with filters and pagination, and count them by state or priority.</p>
</div>

Part of the [TCP protocol reference](/api/tcp/), which describes the framing, authentication, pipelining and response format that every command on this page uses.

Two more read-only commands are documented next to the limits they describe: [`GetQueueLimits`](/api/tcp/control/#getqueuelimits) and [`GetDeduplicationJobId`](/api/tcp/control/#deduplication-introspection).

## Query Commands

### GetJob

Retrieve a job by its internal ID.

**Request:**

```typescript
{ cmd: 'GetJob', id: string }
```

**Response:**

```typescript
{ ok: true, job: Job }
```

Returns an error if the job is not found.

---

### GetState

Get the current state of a job.

**Request:**

```typescript
{ cmd: 'GetState', id: string }
```

**Response:**

```typescript
{ ok: true, id: string, state: string }
```

Possible states: `waiting`, `prioritized`, `delayed`, `active`, `waiting-children`, `completed`, `failed`, or `unknown` (job not found).

---

### GetResult

Get the stored result of a completed job.

**Request:**

```typescript
{ cmd: 'GetResult', id: string }
```

**Response:**

```typescript
{ ok: true, id: string, result: any }
```

The `result` field is the value passed via `ACK`. It may be `null` or `undefined` if no result was stored or if the result has been evicted from the LRU cache.

---

### GetJobs

List jobs with filtering and pagination.

**Request:**

```typescript
{
  cmd: 'GetJobs',
  queue: string,
  state?: JobState | JobState[],  // e.g. 'waiting', 'delayed', 'active', 'completed', 'failed', or an array
  limit?: number,        // Max results (default: 100)
  offset?: number,       // Skip N results (default: 0)
  asc?: boolean          // createdAt/id order (default: true)
}
```

**Response:**

```typescript
{ ok: true, jobs: Job[] }
```

Ordering is applied before pagination. Send the same `asc` value on every
request when traversing multiple offset pages.

---

### GetJobCounts

Get job counts grouped by state for a specific queue.

**Request:**

```typescript
{ cmd: 'GetJobCounts', queue: string }
```

**Response:**

```typescript
{
  ok: true,
  counts: {
    waiting: number,
    prioritized: number,
    delayed: number,
    active: number,
    completed: number,
    failed: number,
    'waiting-children': number,
    paused: number
  }
}
```

When the queue is paused, ready jobs are reported under `paused` instead of `waiting`/`prioritized` (BullMQ semantics).

---

### GetCountsPerPriority

Get job counts grouped by priority level for a specific queue.

**Request:**

```typescript
{ cmd: 'GetCountsPerPriority', queue: string }
```

**Response:**

```typescript
{ ok: true, queue: string, counts: Record<number, number> }
```

---

### GetJobByCustomId

Look up a job by its custom ID (the `jobId` field from PUSH).

**Request:**

```typescript
{ cmd: 'GetJobByCustomId', customId: string }
```

**Response:**

```typescript
{ ok: true, job: Job }
```

Returns an error if no job with that custom ID exists.

---

### Count

Get the number of queued jobs in a queue (`waiting`, `prioritized`, and `delayed`; active, completed, and failed jobs are not counted).

**Request:**

```typescript
{ cmd: 'Count', queue: string }
```

**Response:**

```typescript
{ ok: true, count: number }
```

---

### GetProgress

Get the progress of an active job.

**Request:**

```typescript
{ cmd: 'GetProgress', id: string }
```

**Response:**

```typescript
{ ok: true, progress: number, message: string | null }
```

---

### GetChildrenValues

Get the return values from all child jobs of a parent job. Used with FlowProducer workflows to retrieve results from completed children.

**Request:**

```typescript
{ cmd: 'GetChildrenValues', id: string }
```

**Response:**

```typescript
{ ok: true, data: { values: Record<string, any> } }
```

Keys are `<queue>:<childId>`, or the bare `childId` when the child job no longer exists. Returns an empty `values` object if the job has no
children; a lookup failure returns the normal `{ ok: false, error }` response.
