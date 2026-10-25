---
title: "bunqueue v2.6.75"
description: "removeDependencyOnFailure, ignoreDependencyOnFailure, continueParentOnFailure, job.getFailedChildrenValues() and more."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-75.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-24"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.75</em></h1>
  <p class="bq-hero-sub">removeDependencyOnFailure, ignoreDependencyOnFailure, continueParentOnFailure, job.getFailedChildrenValues() and more.</p>
</div>

## `removeDependencyOnFailure`

When a child job terminally fails with this option set, it is silently removed from the parent's pending dependencies. If it was the last pending child, the parent is promoted to the waiting queue and processed normally.

## `ignoreDependencyOnFailure`

Same as `removeDependencyOnFailure` but also stores the failure reason so the parent worker can retrieve it via `job.getIgnoredChildrenFailures()`.

## `continueParentOnFailure`

When a child job with this option fails, the parent is immediately promoted to the waiting queue (even if other children are still pending). The parent worker can then call `job.getFailedChildrenValues()` to inspect which children failed and why, and `job.removeUnprocessedChildren()` to cancel remaining unstarted children.

## `job.getFailedChildrenValues()`

Returns `Record<string, string>` mapping child keys (`"queue:jobId"`) to their error messages. Populated by `continueParentOnFailure` child failures.

## `job.getIgnoredChildrenFailures()`

Returns `Record<string, string>` of failure reasons for children that failed with `ignoreDependencyOnFailure`.

## `job.removeChildDependency()`

Removes a child job's pending dependency from its parent. If this was the last pending child, the parent is promoted to the queue. Throws if the job has no parent.

## `job.removeUnprocessedChildren()`

Cancels all unprocessed (waiting/delayed) children of a parent job. Active, completed, and failed children are unaffected.

## More additions

- TCP commands for new methods: `GetFailedChildrenValues`, `GetIgnoredChildrenFailures`, `RemoveChildDependency`, `RemoveUnprocessedChildren`.
- All four new options are fully propagated through `FlowProducer.add()`, `FlowProducer.addBulk()`, and the TCP `PUSH` command.

---

[← bunqueue v2.6.74](/blog/bunqueue-v2-6-74/) · [Full changelog](/changelog/) · [All posts](/blog/)
