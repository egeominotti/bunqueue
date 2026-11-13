# Agent harness reliability

The contributor harness coordinates startup, work ownership, regression tests,
isolated validation, evidence and authorized integration. Entry points and
contracts are indexed in [the harness guide](../agents/README.md). It is separate
from the queue runtime and [application agent integrations](agent-integrations.md).

## Sandbox verdicts and cleanup

`scripts/test-sandbox.ts` builds one image and runs unit, TCP and embedded suites
in disposable network-isolated containers. `scripts/test-sandbox-report.ts`
provides the shared `suitePassed` predicate used by product/SDK gates, Markdown,
aggregate JSON and baseline comparisons. Success requires exit zero, no reported
failures or test errors, and valid nonempty totals. Product unit/TCP/embedded
results additionally require complete, consistent final summaries. A successful
exit cannot override failed counters or partial evidence.

`scripts/test-sandbox-cleanup.ts` clears ownership only after successful removal
or an explicit absent-container response. Other Docker errors retain ownership
and report the name, exit code and diagnostic. Per-suite cleanup failures mark
telemetry failed, preserve peer results and write the aggregate report. Signal
cleanup attempts every owned container and reports failure honestly.

Baselines are optional. The reader validates suite names, exit codes, finite
nonnegative durations/peak memory and safe nonnegative counters. Incomplete
baselines are ignored so the current report can still be written.

## Machine ownership and evidence

The Machine gate creates native Ubuntu 24.04 candidates with
`--isolated --isolate-network` from an explicit staged Git tree. Releases also
need Debian 13. No host filesystem, credentials or forwarded agent enter a Machine.

Names are claimed atomically across cooperating worktrees before list/create.
The default directory is `/tmp/bunqueue-machine-claims-$UID`;
`BUNQUEUE_MACHINE_CLAIM_ROOT` overrides it for controlled tests. A run never
deletes a Machine belonging to another claim or a pre-existing Machine.
Failed creation remains uncertain until daemon settlement and ownership checks
resolve it. Uncertain or retained Machines keep their claim; confirmed deletion
releases it.

External calls are bounded, including cleanup queries. Terminating an owned
command also terminates its descendants. Control queries default to 30 seconds
(`BUNQUEUE_MACHINE_CONTROL_SECONDS` shortens controlled tests); create/download/copy
bounds remain separate. Partial copy-back is an infrastructure
failure even if `DONE` and `steps.tsv` arrived: requested step logs and the runner
log are required evidence. `COPY_INFRA` durably records copy failure.
Required test summaries must be complete, consistent and nonempty with no failed
counters, independently of step exit receipts. Typecheck requires both project
completion markers, and formatting requires its completion marker.
Exit 130 requires every owned Machine deleted; `--keep` plus an interrupt leaves
resources and therefore reports exit 4.

The Bash Machine process layer delegates bounded execution to the shared Bun
supervisor. It remains responsible for cooperative worker shutdown and bounded
escalation; the supervisor owns its CLI group. This avoids competing cleanup
controllers and also handles launchers that exit before descendants close streams.

## CI and skill evaluations

The CI watcher reads GitHub only. Its deadline includes external queries, retries
and attempt history. A known failure outranks unavailable history; ordering stays
FAILED, NO VERDICT, FLAKY, GREEN. It never reruns or approves anything itself.
Live watching requires the pinned Bun and `gh`; the Bash help/dry-run paths remain
previews. `scripts/agents/bounded-command.ts` and `skill-eval-process.ts` supply
bounded owned-process execution, while `skill-eval-agents.ts` handles CLI events
and canonical skill identity.

The shared supervisor installs cancellation handlers before spawning a command.
The child can run before `spawn()` returns, so registering handlers afterward
leaves a startup window where SIGTERM terminates the supervisor without cleaning
the detached group. Cancellation during launch is retained until the child PID
is available, then follows the same bounded termination path as later signals.

Skill evaluations stop before scheduling subscription sessions if discovery is
invalid. Session timeouts terminate the owned CLI tree even if SIGTERM is ignored.
SIGTERM/SIGINT cancels scheduling and active children, records interruption, and
exits 143/130; an interrupted run cannot start more subscription sessions.
Codex measurements require successful completed commands referencing this checkout's skill,
including canonical paths written with shell quoting or escaped spaces,
preventing stale user copies and failed commands from being attributed to the
measured description. See [evaluation methodology](../agents/skill-evals.md).

Launch failures still write evaluation reports with diagnostics and preserve
already collected outcomes; they fail the campaign instead of discarding evidence.

## Regression coverage and instructions

Real entry points run against temporary repositories and controlled Docker,
OrbStack, GitHub and agent CLIs. Tests assert verdicts, reports, ownership and
surviving resources, including concurrent creation, partial evidence and cleanup
failures. Host probes are diagnostic; full sandbox and fresh Machine gates remain
required.

Shared `CLAUDE.md`/`AGENTS.md` contracts preserve user changes, synchronous shard
sections, exactly-once invariants, deterministic pagination/migrations, scheduling
regressions and complete test-tree type checking. State records ownership but
never authorizes commit, push or publication.
