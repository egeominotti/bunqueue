---
title: "bunqueue v2.8.47"
description: "Fixes 40 bugs. An injected clock for the workflow engine, A deterministic simulation suite, property-based tests over the workflow engine's pure core, saga hardening and more."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-47.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-30"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.47</em></h1>
  <p class="bq-hero-sub">Fixes 40 bugs. An injected clock for the workflow engine, A deterministic simulation suite, property-based tests over the workflow engine's pure core, saga hardening and more.</p>
</div>

Saga rollback becomes trustworthy: it now covers the steps it used to miss, refuses to
claim work it did not undo, and parks for an operator instead of failing quietly.

Everything shipped here is in the **experimental** workflow engine
(`bunqueue/workflow`). Queue, worker, cron, flows and the wire protocol are untouched: no
runtime file outside `src/client/workflow/` changed, and nothing in the core imports that
module. The test-gate entry below is the one exception, and it ships nothing: it is in
`scripts/`, which is not part of the published package.

#### To install bunqueue v2.8.47

```bash title="bun"
bun add bunqueue@2.8.47
```

```bash title="npm"
npm install bunqueue@2.8.47
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## An injected clock for the workflow engine

(`clock.ts`). Every `Date.now()`,
`Math.random()` and timer in `src/client/workflow/` now reads from it, and the real
clock is the default, so nothing changes unless a test installs `simulatedClock(seed)`.
With one installed, retry backoff, signal timeouts, execution ids and persisted
timestamps all become functions of that seed, so a failure replays exactly instead of
once in eleven campaigns. Measured on a live run with two retries: 1794 ms of wall
time becomes 66 ms, with the waiting visible on the simulated clock instead.
SQLite, the queue's worker loop and the OS scheduler are still real, so the engine as
a whole is not deterministic; its own contribution is.

## A deterministic simulation suite

(`test/workflow-dst.test.ts`).

## Property-based tests over the workflow engine's pure core

(`test/workflow-properties.test.ts`): round-trip across the persistence boundary,
idempotency-key stability and metamorphic behaviour, loop-name inversion, and the
gate guard checked against a naive oracle. It found the inherited-member gate defect
above on its 202nd generated case.

## Saga hardening

The failing step and sub-workflow records are part of the unwind
set; a failed reversal parks the run in the non-terminal `compensation-stuck` state,
with `engine.resumeCompensation()` and `engine.abandonCompensation()` as the ways
out; `.pivot()` marks a point of no return past which nothing is rolled back; and
`rollbackStatus` is tracked separately from `failureReason`, because "the payment
failed" and "the refund never went through" need different alerts.

## Idempotency keys

On every step, shaped `run:step#occurrence:direction` and
invariant across retries and crash-resume. Compensate handlers also receive
`ctx.forwardIdempotencyKey`, so a rollback can ask a provider whether the forward
operation actually happened.

## Loop memoisation

A completed iteration is not re-run when its node is re-entered
after a crash, so a loop resumes at the iteration it was interrupted on.

## Versioned API reference

At `/reference/<version>/`, generated from source with
TypeDoc over the package's own `exports` map. Build it with `bun run docs:api`.

## A dedicated Workflow Engine section in the guide

Nine pages covering steps and
control flow, rollback, durability, human approval, and integrations with the Vercel
AI SDK, Claude Agent SDK, OpenAI Agents SDK, Mastra and LangGraph. Every example on
those pages is executed by a test.

## More additions

- **The two decisions where every rollback and duplicate-execution defect lived are now
  pure functions**: `unwindPlan.decideUnwindAction` (what to do with each record of an
  unwind) and `admission.decideAdmission` (whether a node job may run). The impure
  loops that surround them became dispatchers. Both were previously buried in async
  methods that also read SQLite and emitted events, so observing a decision meant
  standing up an engine, a database and a real race; each is now covered by generated
  inputs in under a tenth of a second.
- Types reachable from `Execution` and `StepRecord` are now exported and nameable:
  `RollbackStatus`, `CompensationStatus`, `CompensationOutcome`, `BranchCondition` and
  `WorkflowNode`.

## Changes

- **`signal()` on a run that is not running or waiting now throws.** It used to be
  accepted: the payload was written into the persisted row and `signal:received` was
  emitted, so a dashboard reported an approval against a run that had already ended and
  a closed audit record was mutated after the fact, while the caller got a clean return
  for a delivery that did nothing. A signal racing a run to its end is real, and this
  is how the caller finds out.

- **`__proto__` is refused as an event name**, at `register()` and at `signal()`.
  Assignment to that name writes an object's prototype instead of creating a key, so
  the payload was stored nowhere: the gate never saw its own signal, re-parked, expired
  on its timeout, and the unwind reversed work the approver had authorised. Supporting
  it would mean reconciling the storage codec, which renames `__proto__` to `__proto_`
  as its own pollution defence, so the gate would be stored under a different name than
  it was signalled with.

- **Two `waitFor` nodes on the same event are now rejected at `register()`.** A
  delivered signal is never consumed, and a wait is satisfied by the event key being
  present, so a run shaped `waitFor('approve')`, pay, `waitFor('approve')` was walked
  end to end by ONE signal: the second gate never paused. A four-eyes control silently
  became a one-eye control, with nothing in the state, events or logs to say a gate had
  been skipped. Give each gate its own event name. A `waitFor` with no event name at
  all is refused for the same reason: a gate nobody can name is a gate nobody can open,
  and two of them were opened by one signal.

- **`engine.abandonCompensation()` is now `async`.** It did the same synchronous work
  but threw synchronously, so the defensive form an operator reaches for under
  pressure, `Promise.allSettled([resume(id), abandon(id)])`, threw before
  `allSettled` was ever called instead of settling. It now matches its sibling.

- **`forEach` now rejects a non-array item source.** It read `.length` and indexed
  directly, and JavaScript is generous about what has a length: a number iterated
  ZERO times and still reported `completed`, so a batch that processed nothing looked
  exactly like a batch with nothing to do, and a string iterated its CHARACTERS, so an
  id list that arrived as `'u1,u2'` silently processed five items nobody passed. Only
  `null` and `undefined` failed, and only by accident. It now throws.

- **Two workflow shapes that used to register now throw at `register()`.** Both were
  accepted before and neither did what it looked like:
  - a `waitFor` (or any non-step node) inside `.path()`, `.parallel()` or a loop body.
    A path runs inline inside a single job, so it has nowhere to park: on 2.8.46 such a
    run **completed without ever waiting for the signal**, silently skipping the
    approval gate.
  - a step whose name collides with a loop's `name:index` namespace, e.g. a step called
    `turn:0` beside a loop body called `turn`. Harmless before because loops did not
    write indexed records; this release introduces them, and the collision would
    overwrite an iteration's history.
- **`ExecutionState` gained `compensation-stuck`.** An exhaustive `switch` over that
  type in consumer code will no longer compile until the new case is handled.

- **`compensate: async (ctx) => ...` now type-checks.** The option was a union of two
  function types, and TypeScript cannot contextually type a parameter against a union
  of signatures, so the inline form used by every documented example was an implicit
  `any` and failed under `noImplicitAny`. It is now a method taking a permissively
  typed step map, which restores inference while still accepting every handler shape
  the union accepted. The trade is that `ctx.steps` inside a rollback is not narrowed
  to the accumulated step types; handlers that want that annotate their own parameter.

## Bugfixes

- **A `doUntil` or `doWhile` iteration that failed after moving money was dropped from
  the rollback entirely.** The per-iteration record was written only after the body
  returned, so the turn that threw existed under the bare loop name alone, and that bare
  name is deliberately excluded from the unwind because it mirrors the last iteration and
  compensating it too would undo that iteration twice. A loop that charged on every turn
  and failed on turn 2 refunded turns 0 and 1, left turn 2's charge standing, and still
  reported `rollbackStatus: 'completed'`. The failed turn is the one MOST likely to need
  undoing: a charge that reached the provider and then lost the response is recorded
  failed while the money has already moved. The record was unreachable even by
  `abandonCompensation`, which walks the same set, so no operator action could give it an
  outcome. `forEach` was never affected.
- **A sub-workflow that failed, parked or timed out was dropped from its parent's
  rollback.** The `sub:` record was written `running` before the wait and `completed`
  only on success, so every other outcome left it in flight, and the unwind skips
  anything that is neither `completed` nor `failed`. A parent whose child was parked with
  stock still reserved reversed its own steps, reached the end of the pass and reported a
  clean rollback. The record is now settled `failed`, the parent inherits the child's
  park, and `resumeCompensation()` on the parent reaches the child.
- **`abandonCompensation()` left a renamed step with no outcome at all.** Two gates
  decided eligibility and disagreed: the unwind kept a record whose definition had
  vanished but which ran with a handler, and the abandon path re-decided from the
  definition alone and walked past exactly that record. The run then ended terminal with a
  step owed a reversal it will never get, in the function that exists to discharge
  "exactly one outcome per eligible step, never zero".
- **One failing database write mid-rollback closed both operator exits and armed a
  duplicate reversal.** The per-step write sat outside the error handling, so a
  `SQLITE_BUSY` escaped the whole pass and left the run `compensating`: `resumeCompensation`
  and `abandonCompensation` both require `compensation-stuck`, so neither was available,
  while recovery does pick `compensating` runs up and re-drove the pass, running the
  reversal whose outcome never reached disk a second time. The pass now stops at the
  first write it cannot persist, parks the run so it stays actionable, and still reports
  the original write error. This covers the `compensating` transition write as well, which
  happens on every unwind and had the same hole: nothing had been undone yet, and the run
  was left with no operator exit and outside the range recovery looks at.
- **A parent could roll back a sub-workflow that was still running.** A child that outlives
  the 300 second poll ceiling makes the parent's step fail while the child is very much
  alive, and the parent then rolled it back underneath its own forward steps: two writers
  on one row, compensate handlers interleaved with forward progress, and a child free to
  reach `completed` with its undo already done. A child that has not stopped is now
  refused, and the parent parks with a reason that says so. Resolve the child, then resume
  the parent.
- **A store that refused the failure write replaced the step's real error.** Reported for
  any step, and separately inside loops, where the write ran in a `finally` while the
  step's exception was propagating and an exception from a `finally` supersedes the one in
  flight. Either way, "provider timeout after the charge settled" was recorded as
  "SQLITE_BUSY", and that message is the whole account of what went wrong. The step's own
  error now wins in all three places, and a write failure with no step error behind it
  still surfaces instead of being swallowed.
- **`retry: 0` was accepted and produced a TypeError as the failure reason.** `retry` is
  the number of attempts, so zero never ran the body, and the code after the retry loop
  read a record that was never written: the run's `failureReason` became
  `undefined is not an object (...)`, where an operator looks for what happened. In a
  resumed loop it wrote a `failed` record for a handler that was never called, which the
  rollback then reversed. It is now refused where it is written, by `step()` and by
  `forEach()`, with a message that says what to write instead.
- **An unwind that could not record its own first write still decided outcomes.** The
  vanished-step check runs ahead of the halted check, by design, so a renamed step was
  marked `compensation-failed` and announced with an event in a pass where no handler ran
  and the store had refused everything. The in-memory outcomes then disagreed with a disk
  that had received nothing, and the event pointed at the wrong cause.
- **The isolated test gate reported `passed: true` in `summary.json` for a run that
  observed nothing.** The markdown verdict and the process exit code already refused a
  suite that exited 0 with zero tests counted; the machine-readable artifact, which the
  handoff process is told to read, used a different predicate and disagreed. All four
  readers, including the SDK gate and the baseline comparison, now share one.

- **A deploy that renamed a step destroyed the record of a reversal that had already
  SUCCEEDED.** The check that halts on a vanished step fired on any record carrying an
  outcome, including `compensated`, and the unwind then wrote `compensation-failed` over
  it and emitted a matching event. An operator acting on that record releases the same
  stock twice, the pass halts there so the reversal that actually failed is never
  retried, and the ordering is deterministic, so every later resume halts in the same
  place. Only a reversal that failed, or one that was owed and never reached, halts now.
- **A renamed step that had not been reversed yet was dropped from the unwind.** Nothing
  distinguished "never owed a reversal" from "owed one and the handler is gone", so the
  run reported a clean rollback over work nobody undid. A step record now remembers
  whether it declared a `compensate` handler when it ran.
- **`resumeCompensation()` on a nested saga was a silent no-op that resolved
  successfully.** The retry was not forwarded to the child, so the child halted on its
  own failed reversal, the parent re-parked, and the call returned cleanly having done
  nothing. The guide names that exact call as the way out of a parent that inherited its
  child's park.
- **A child parked mid-rollback held its parent for the full 300 second poll**, which
  then reported a timeout: the wrong diagnostic for the one scenario this module exists
  for, and a worker slot held for five minutes to produce it. The parent now stops at
  once with the real reason.
- **`rollbackStatus: 'not-started'` was documented in three places and never assigned.**
  A dashboard rendering the documented values showed blank. The field is absent until an
  unwind is attempted, and the type and the docs now say so.

- **A `parallel()` group that broke in two places recorded one cause.** The
  `AggregateError` carried every failure, but the persisted `failureReason` took only
  the first message, so an operator read one problem and went looking for a single
  cause that was not the only cause. It now reads `2 failures: card declined; warehouse
offline`, and a lone failure still reads as itself.

- **A reversal that failed was walked past on the next pass, and the run then declared
  a clean rollback.** The unwind decided whether to stop from the failures of THIS pass
  only, so a record carrying `compensation-failed` from an earlier one was read as
  already settled and skipped. Reaching a second pass takes only a crash while an
  unwind is in flight: the row stays `compensating`, recovery drives it again, and it
  ended `rollbackStatus: 'completed'` with a reversal still sitting in
  `compensation-failed`. An unresolved failure now stops the chain exactly as it did
  the first time. `resumeCompensation()` is the one exception, because that is what it
  asks for.
- **A restarted parent started a SECOND sub-workflow child and abandoned the first.**
  The node started a child unconditionally instead of resuming the one it had already
  started, and re-entering the node is routine: a restart plus `recover()` re-enqueues
  the parent's current node. Measured across one restart, the child ran twice, so the
  work was duplicated rather than merely leaked, and both rows sat `running` forever
  since a child is excluded from recovery while its parent exists and cleanup only
  reaps terminal states. The parent now claims its child before waiting and resumes it.
- **`resumeCompensation()` no longer destroys the record it is retrying.** It used to
  clear the failed outcome and persist that wipe before running anything, so a resume
  that then met a failing store left a durable row with the diagnostic gone and the run
  marked `compensating`, to be re-driven at every startup. The retry is now asked for
  with a flag, so nothing is destroyed and the deep snapshot, restore path and second
  write that could mask the original error are all gone with it.
- **`recover()` counted work it had not done.** A node already in flight was
  re-enqueued and counted as recovered, though the admission check then rejected the
  job. It is now consulted first, so the returned counts describe what actually
  happened.

- **A deploy that renamed a step made a parked unwind report a clean rollback over an
  unreversed charge.** Three things compounded: the failure record was wiped on the way
  into `resumeCompensation`, the step was then dropped from the unwind set because its
  definition no longer resolved, and with nothing left to halt on the unwind reached its
  end and wrote `rollbackStatus: 'completed'`. Measured: the operator saw green with
  zero refunds executed and no record of the failure they had been acting on. A settled
  record now stays in the unwind set even when its definition is gone, the unwind halts
  on it, and the reason names the missing step.

- **A compensate handler that threw a structured error recorded `[object Object]`.**
  `String(err)` was applied before the diagnostic was persisted, and a `throw { code:
502, detail: ... }` from an HTTP client is ordinary. The result was stored on a run
  parked in `compensation-stuck`, the state that exists so an operator has something to
  act on, and it said nothing about a refund that had not gone through. Non-Error
  throws are now described, with the class name as a fallback when nothing serialises.

- **A duplicate execution id silently overwrote a live run.** The insert was
  `INSERT OR REPLACE`, so a collision replaced an execution rather than failing. Ids
  carry a random component, which makes it vanishingly rare against the real clock and
  reachable under a seeded simulation. It is now a plain `INSERT`: a lost execution is
  the worst presentation of a collision, a constraint error is the best.

- **An approval gate named after an inherited member opened by itself.** `exec.signals`
  is a plain object used as a map and presence was asked with `in`, which walks the
  prototype chain: `'toString' in {}` is true. A run shaped `.waitFor('toString')` was
  resumed the instant it parked, with nobody having signalled anything, and the step
  behind the gate ran. `constructor`, `valueOf`, `hasOwnProperty` and the rest behaved
  the same, and an event name read from config or user input is attacker-influenced.
  Presence is now asked with `Object.hasOwn`. Found by the new generated-input suite,
  which tries event names a human would not think to write.

- **Schema `parse()` output was discarded, so coercion silently did nothing.**
  `inputSchema`/`outputSchema` are documented with Zod, and `parse()` is the coercing
  entry point of every such library: `.default()` fills gaps, `.transform()` rewrites,
  `z.coerce.date()` builds a Date from a string. The engine called `parse()` for its
  throw and threw the return value away, so a step declaring `.default('EUR')`
  validated fine and ran with no currency, and the next step read the raw value. The
  parsed value is now what the run carries forward. A validator that returns nothing
  still works: `undefined` means "assert only" and the original value is kept.

- **`signal(id, event)` with no payload no longer does nothing.** `payload` is optional,
  so the most idiomatic human-in-the-loop call, "the approver said go", nothing to
  carry, was recorded as `signals[event] = undefined`. The codec runs with
  `structuredClone: true` and round-trips `undefined` faithfully, so the key was
  present but the value was not, and every presence test asked
  `signals[event] !== undefined`, which is a value test. The engine's two halves then
  disagreed: `record()` claimed the resume and re-enqueued the node, and the `waitFor`
  it resumed into was told no signal had arrived and parked the run again. With no
  timeout the run waited forever after being approved; with a timeout the approval was
  converted into a timeout **failure**, compensating work the approver had just
  authorised. Presence is now a key test (`hasSignal`, `event in signals`) at all four
  decision points, `storeSignals.park`, the `waitFor` pre-check, the `waitFor` timeout
  re-read, and the crash-recovery resume. An explicit `null` payload always worked and
  still does. (`workflow/storeSignals.ts`, `waitFor.ts`, `recovery.ts`,
  `test/repro-workflow-signal-no-payload.test.ts`)

- **A parked `waitFor` no longer keeps the process alive.** Clamping long waits to
  `setTimeout`'s 32-bit ceiling turned a fires-immediately bug into a real 24.8-day
  handle, so a process whose only remaining work was a parked approval gate never
  exited, even after `close()`. Timers are unref'd, and `Engine.close()` releases them.
- **`abandonCompensation` left sub-workflows with no outcome.** It decided eligibility
  with `findStepDef()`, which walks step nodes only, so every `sub:` record finished an
  abandoned unwind with `compensation === undefined`, contradicting the documented
  "exactly one outcome per eligible step, never zero".
- **A compensation could run twice.** Both the in-flight case (`recover()` over a live
  unwind) and the sequential one (`recover()` driving a parent whose child it also
  holds a stale snapshot of) re-dispatched handlers that had already run: a refund
  issued twice, with no trace in the final state.
- **A duplicate node job re-ran the node and every node after it**, giving one
  execution two independent advance chains, doubled side effects, and a final state of
  `completed` that hid it. `recover()` on a live engine is the reachable path, since it
  re-enqueues the current node of every running execution. A node now runs under an
  in-flight claim, and a job for a node the run has already left is ignored.
- **Every iteration of `doUntil` / `doWhile` is now compensated, not only the last.**
  Loop bodies were matched by exact name, so `turn:0`, `turn:1` and the rest resolved
  to nothing: a loop that charged a card once per iteration issued exactly one refund.
- **Each loop iteration's compensate handler sees its own result.** The bare step name
  mirrors the last iteration, so every handler read the final value: three charges
  produced three refunds of the third one.
- **A step whose name merely contains a colon is no longer treated as a loop
  iteration.** A step called `charge:extra` alongside a loop body called `charge` was
  resolved to the loop's definition, so the loop's rollback ran twice and its own never
  ran. Only a numeric `:<digits>` suffix, the one this engine generates, is structural,
  and the match is anchored: a loop body named `charge:extra` produces `charge:extra:1`,
  which is an iteration of `charge:extra` and not of `charge`. Unanchored, that record
  ran `charge`'s reversal four times, never ran its own, and still reported
  `rollbackStatus: 'completed'`.
- **A wedged compensate handler hung the run forever.** Handlers are bounded by the
  step's `timeout`, like the forward path. Previously one that never settled left the
  run in `compensating` rather than `compensation-stuck`, so no parked run existed for
  an operator to resume or abandon.
- **A sub-workflow past its own `.pivot()` was reported as compensated.** Nothing of a
  committed child is undone, so the parent now parks instead of recording a rollback
  that provably did not happen.
- **Recovery drove a sub-workflow child on its own, so its rollback ran twice.** A
  child started by `subWorkflow` is a row like any other, and recovery selected purely
  on state, so it picked the child up as a top-level run and drove it behind its
  parent. Its steps re-ran, the fresh records carried no compensation outcome, and the
  "never twice" guard therefore did not fire when the parent later unwound that same
  child: the reversal was dispatched a second time against a provider already
  refunded. A child now records the parent that owns it and is left to it, unless the
  parent row is gone. Found by the state-machine model, seed `1267197984`.
- **A failed `resumeCompensation()` made the next one run a reversal twice.** The
  operator retry snapshots the step records and handed the whole snapshot back if the
  attempt threw, which also erased the reversals that had SUCCEEDED before the throw.
  The run parked looking untouched, so resuming again refunded twice. The restore now
  merges: it gives back only what the attempt left unsettled.
- **An unwind with nothing eligible left the run non-terminal on the recovery path.**
  Only the `runNode` caller set the final state, so a persisted `compensating` run
  whose steps no longer resolve, after a deploy renamed one, came back from
  `listRecoverable()` at every startup and was re-driven forever.
- **`timeout: 0` left a reversal unbounded.** That is the documented way to say "no
  bound" on the forward path and stays so, but an unbounded reversal holds the
  engine's in-flight claim, locking the run out of `recover()`,
  `resumeCompensation()` and `abandonCompensation()` for the life of the process. A
  reversal now falls back to 30000 ms.
- **`cleanup(0)` and `archive(0)` archived nothing when a run had just finished.** Both
  filtered with a strict `updated_at < cutoff`, and with a zero max age the cutoff is
  the current millisecond, which is exactly where a just-completed run sits. The cutoff
  is now inclusive, so the documented "flush everything terminal" call does that.
- **`SQLITE_BUSY` could surface from `signal()`.** The engine hands the same data path
  to the workflow store and to its embedded queue, two connections on one file, and the
  store had no `busy_timeout`. It is now 5 s.

## Notes

The workflow engine is a Bun, in-process API. It is not part of the wire protocol and
is not implemented in the Python, PHP, Go, Rust or Elixir clients; those clients can
push jobs that a Bun process running a workflow then consumes.

**Upgrading with a run already parked.** Step records now carry `compensatable`, which is
what tells "never owed a reversal" apart from "owed one and the step has since been
renamed away". Rows written by an earlier version do not have the field, so a run that was
already parked in `compensation-stuck` before the upgrade keeps the old behaviour for the
renamed-step case: its unreached steps are treated as owing nothing. Runs started after the
upgrade carry the field from their first write. If you have a parked run you care about,
resolve it before upgrading.

---

[← bunqueue v2.8.46](/blog/bunqueue-v2-8-46/) · [Full changelog](/changelog/) · [All posts](/blog/)
