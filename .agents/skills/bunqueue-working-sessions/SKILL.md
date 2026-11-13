---
name: bunqueue-working-sessions
description: "Runs the bunqueue agent-harness session lifecycle. Use when starting, resuming or ending a bunqueue coding session, when handing off work, when ./init.sh fails, when claiming, adding or editing a work item in feature_list.json or progress.md, when asked what evidence marks an item done, or when those files conflict in a rebase or fail the harness contract test. Covers one in-progress item per branch, Definition of Done evidence and session-handoff.md. Not for the content of a fix or a release, or for running the gates."
license: MIT
metadata:
  short-description: Start, track and hand off a bunqueue session
---

# Working sessions in bunqueue

The Startup Workflow, Working Rules, Definition of Done and End of Session are in
[CLAUDE.md](../../../CLAUDE.md#startup-workflow) and [AGENTS.md](../../../AGENTS.md#startup-workflow);
the state files and their contract are described in
[docs/agents/README.md](../../../docs/agents/README.md). This skill is how to carry them
out without breaking the files other sessions edit at the same time. Nothing in a state
file authorizes a commit, push, version bump, release or publication.

## Start

1. `pwd` and `git branch --show-current`: know which worktree and branch you are in.
2. `./init.sh` ([init.sh](../../../init.sh)). It stops at the first failure; a green run
   prints the work items in progress, blocked or ready, then the agent skills and the
   next steps. A red baseline is repaired before any new scope; if you cannot repair it,
   record it under Blockers in `progress.md`.
3. Read `progress.md` (Current State and the newest Session Log entry) and
   `git log --oneline -5`.

## Claim one work item

- Pick one item of [feature_list.json](../../../feature_list.json) whose dependencies are
  all `done`, or add one (kebab-case `id`, `issue` when known) at its id-sorted
  position: the contract test checks the order.
- Set `status` to `in-progress` and `branch` to the branch name without the account
  prefix. `git branch --show-current | sed 's#^[^/]*/##'` turns
  `<user>/tls-sighup-reload` into `tls-sighup-reload`; the stripped name, never the
  full one, goes into committed files.
- Without the prefix two people's branches can share a name, and the
  one-item-per-branch check then reads them as one branch. Name the branch `<topic>`;
  when someone else may pick the same topic, add a short unique suffix
  (`tls-sighup-reload-k7`).
- A branch owns at most one `in-progress` item. If this branch already owns one (a
  release in progress, for example), finish or block it first, or work on another
  branch.
- Edit only your own item. Unrelated findings become new `not-started` items.

## Record evidence as you go

`evidence` is what actually ran, written so the next session can check it: date and
base commit, each command with exact totals, artifact paths, the gated tree hash, the
commit, and the skeptic verdict. Prefix it `PARTIAL` while gates are pending. Examples
and the Definition of Done mapping: [references/evidence.md](references/evidence.md).
A `done` item needs evidence and may depend only on `done` items.

## End the session

1. `progress.md`: update only your item's lines in Current State (with the
   `**Last Updated:**` date, done, next, Blockers/Risks) and prepend a dated Session
   Log entry under the heading.
2. `feature_list.json`: your item's `status`, `evidence`, `branch`.
3. Multi-session work: fill the sections of [session-handoff.md](../../../session-handoff.md)
   into that Session Log entry, including which explicit user requests exist so far.
4. Record every risk, blocker and check you could not run; a gate that did not run is
   a blocker, not a pass.
5. Leave `./init.sh` green. Commit only when the user asked, through the gates.
6. After a push, the session is not over until the CI run of the pushed commit is
   green: watch it and handle a red or flaky run as bunqueue-running-gates describes.

## Rebase conflicts in the state files

| File | Resolution |
| --- | --- |
| `feature_list.json` | keep both items, in id order; rename the newer id if two sessions chose the same one |
| `progress.md` `**Last Updated:**` | the newest date |
| `progress.md` Session Log | keep both entries, newest first |
| `progress.md` Current State | keep each session's own lines |

Run `bun test test/agent-harness test/agent-skills` after resolving; it checks ids,
order, dependencies and the one-item-per-branch rule.

## Gotchas

- The account prefix leaks easily: a `branch` copied from `git branch --show-current`,
  a Session Log line or a handoff that names `<user>/<branch>`.
- Two sessions that each add an item at the end of `features[]` conflict on the same
  lines; inserting at the id-sorted position avoids most conflicts.
- `./init.sh` is the startup check, not a gate: it runs no product suite, and of the
  harness and skills contracts only the fast ones. Process-heavy Machine and CLI
  deadline/cancellation tests remain in the unit suite, with their inventory and
  discovery checked by `test/agent-harness-init.test.ts`. `./init.sh --full` adds `bun run test:sandbox`, on the
  current working tree.
- `./init.sh --workspace` prints the directory, branch and `HEAD` and stops. A notice
  that the git steps are skipped means the directory is not the root of a checkout: a
  sanitized Machine snapshot (no `.git`) skips them by design, so run
  `git diff --check` on the host instead.
- `init.sh` writes ignored output only (`node_modules`, `dist`, `sdk/typescript/dist`,
  `docs/node_modules`); a dirty `git status` after it means something else changed.
- Never run `git reset`, `git checkout`, `git clean`, or discard unrelated edits unless
  the user explicitly requests it ([AGENTS.md](../../../AGENTS.md#working-rules)), and
  never a bare `git stash`: the stash is shared by every worktree of the repository.
