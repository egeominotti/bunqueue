---
title: 'TCP Flow Dependency Commands'
description: 'bunqueue TCP flow dependency commands used by FlowProducer: legacy parent linking, failed and ignored child values, and removing child dependencies.'
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/api/tcp/flows.png
---

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">api reference · tcp · flows</span>
  <h1 class="bq-hero-h1 bq-bench-h1">Parents and children, <em>linked.</em></h1>
  <p class="bq-hero-sub">The parent/child dependency commands behind FlowProducer: legacy parent linking, child failure values, and removing a child dependency or the unprocessed children.</p>
</div>

Part of the [TCP protocol reference](/api/tcp/), which describes the framing, authentication, pipelining and response format that every command on this page uses.

The atomic graph commit, [`PUSHF`](/api/tcp/jobs/#pushf), is documented with the job commands. Child return values are read with [`GetChildrenValues`](/api/tcp/queries/#getchildrenvalues), and an active job parks for its children with [`MoveToWaitingChildren`](/api/tcp/control/#movetowaitingchildren).

## Flow Dependency Commands

Used by FlowProducer for parent/child job graphs.

### UpdateParent

**Request:** `{ cmd: 'UpdateParent', childId: string, parentId: string }`

**Response:** `{ ok: true }`

This is a compatibility command for legacy multi-request flow creation. If the
parent already declares `childId`, only the child's temporary parent marker is
updated; the parent may be active or terminal and its state/topology is not
rewritten. A queued, active, completed, DLQ, or `removeOnComplete`-tombstoned
child is accepted when that declared edge is consistent. Persisted job/DLQ data
and any failure-outbox key move atomically. A genuinely new edge still requires
a queued parent; conflicting ownership, self-links, and undeclared missing
nodes fail.

### GetFailedChildrenValues

**Request:** `{ cmd: 'GetFailedChildrenValues', id: string }`

**Response:** `{ ok: true, values: Record<string, any> }`

### GetIgnoredChildrenFailures

**Request:** `{ cmd: 'GetIgnoredChildrenFailures', id: string }`

**Response:** `{ ok: true, values: Record<string, any> }`

### RemoveChildDependency

**Request:** `{ cmd: 'RemoveChildDependency', id: string }`

**Response:** `{ ok: true, removed: boolean }`

### RemoveUnprocessedChildren

**Request:** `{ cmd: 'RemoveUnprocessedChildren', id: string }`

**Response:** `{ ok: true }`
