---
title: 'TCP DLQ Commands: Inspect, Retry, Purge'
description: 'bunqueue TCP dead-letter queue commands: list entries with filters, read DLQ stats, retry, purge or remove failed jobs, and re-queue completed jobs.'
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/api/tcp/dlq.png
---

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">api reference · tcp · dead letter queue</span>
  <h1 class="bq-hero-h1 bq-bench-h1">Failed jobs, <em>on the wire.</em></h1>
  <p class="bq-hero-sub">Inspect dead-letter entries with filters, read aggregate DLQ statistics, retry, purge or permanently remove failed jobs, and re-queue completed ones.</p>
</div>

Part of the [TCP protocol reference](/api/tcp/), which describes the framing, authentication, pipelining and response format that every command on this page uses.

A job is moved to the DLQ on demand with [`Discard`](/api/tcp/control/#discard), and per-queue DLQ settings are managed with [`SetDlqConfig` / `GetDlqConfig`](/api/tcp/control/#setdlqconfig--getdlqconfig).

## DLQ Commands

### Dlq

Retrieve jobs from the dead-letter queue.

**Request:**

```typescript
{
  cmd: 'Dlq',
  queue: string,
  count?: number,        // Max entries to return (optional)
  filter?: {
    reason?: string,
    olderThan?: number,
    newerThan?: number,
    retriable?: boolean,
    expired?: boolean,
    limit?: number,
    offset?: number
  }
}
```

**Response:**

```typescript
{ ok: true, jobs: Job[], entries: DlqEntry[] }
```

---

### GetDlqStats

Read aggregate DLQ health for a queue.

```typescript
{ cmd: 'GetDlqStats', queue: string }

{ ok: true, data: { stats: DlqStats } }
```

---

### RetryDlq

Retry jobs from the dead-letter queue (move them back to waiting).

**Request:**

```typescript
{
  cmd: 'RetryDlq',
  queue: string,
  jobId?: string,        // Retry a specific job (optional; omit to retry all)
  count?: number,        // Cap the number of entries retried (omit = retry all)
  filter?: DlqFilter     // Retry only matching entries
}
```

**Response:**

```typescript
{ ok: true, count: number }  // Number of jobs retried
```

---

### PurgeDlq

Clear all jobs from the dead-letter queue.

**Request:**

```typescript
{ cmd: 'PurgeDlq', queue: string }
```

**Response:**

```typescript
{ ok: true, count: number }  // Number of jobs purged
```

---

### RemoveDlqJob

Permanently delete one failed job without retrying it.

**Request:**

```typescript
{ cmd: 'RemoveDlqJob', queue: string, jobId: string }
```

**Response:**

```typescript
{ ok: true, data: { removed: boolean } }
```

`removed: false` is an idempotent miss. Persistence or handler failures return
the normal `{ ok: false, error }` response and must not be interpreted as a
missing entry.

---

### RetryCompleted

Re-queue completed jobs back to waiting state.

**Request:**

```typescript
{
  cmd: 'RetryCompleted',
  queue: string,
  id?: string,           // Retry a specific job (optional; omit to retry all)
  count?: number,        // Non-negative cap
  timestamp?: number     // completedAt must be <= this epoch-ms cutoff
}
```

**Response:**

```typescript
{ ok: true, count: number }
```
