# Agent Harness

How a coding agent starts, stays in scope, verifies its work and hands it over in
this repository. Claude Code reads [`CLAUDE.md`](../../CLAUDE.md), Codex reads
[`AGENTS.md`](../../AGENTS.md); both are short routing pages carrying the same
mandatory rules, and the detail lives in the pages below (progressive disclosure:
an agent loads a reference page only when its task needs it). The structure
follows the five-subsystem model of the `harness-creator` skill from
learn-harness-engineering.

| Subsystem    | Artifact                                                                        | Purpose                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Instructions | `CLAUDE.md`, `AGENTS.md`                                                        | Mandatory invariants and gates, Startup Workflow, Working Rules, Definition of Done, End of Session, and a routing table to the pages below.  |
| State        | [`feature_list.json`](../../feature_list.json), [`progress.md`](../../progress.md) | Work items with status, dependencies and evidence; the current state, blockers, decisions and a newest-first session log.                    |
| Verification | [`init.sh`](../../init.sh)                                                      | The startup check. The real gates (`bun run test:sandbox`, `bun run test:model`, `bun run test:sandbox:sdk`) are in [testing.md](../testing.md). |
| Scope        | `feature_list.json` dependencies and branches                                   | One `in-progress` item per branch, dependencies that exist and form no cycle, `done` only with evidence.                                      |
| Lifecycle    | [`session-handoff.md`](../../session-handoff.md)                                | The handoff template a multi-session item fills into its `progress.md` Session Log entry.                                                     |

## Reference pages

| Page                                             | Moved from                     | Contents                                                                                                                                                                             |
| ------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [project-reference.md](./project-reference.md)   | `CLAUDE.md`; repository map from `AGENTS.md` | Architecture flow, directory structure, code guidelines, sharding, lock hierarchy, memory bounds, environment variables, TCP commands, CLI, SQLite schema, test commands, performance, background tasks, repository map. |
| [client-reference.md](./client-reference.md)     | `CLAUDE.md`                    | Simple Mode, Workflow Engine, Client SDK, job options, worker options.                                                                                                               |
| [debugging.md](./debugging.md)                   | `CLAUDE.md`, `AGENTS.md`       | Debug endpoints, memory debugging, CPU and heap profiling.                                                                                                                           |
| [release.md](./release.md)                       | `CLAUDE.md`, `AGENTS.md`; the checklist is new | Release authorization, release checklist (new), npm trusted publishing, release blog posts.                                                                                 |
| [Agent test rules](../testing.md#agent-test-rules) | `CLAUDE.md`, `AGENTS.md`; the startup-check paragraph is new | Isolation rules, model campaign rules, the OrbStack Machine gate checklist, test hygiene.                                                                     |

Each page says which of its sections are moved verbatim and which text is new. The reference pages are summaries for agents. The engineering reference
([README.md](../README.md), [architecture.md](../architecture.md),
[data-model.md](../data-model.md), [features/](../features/)) and the code are
authoritative; a change that makes a summary wrong corrects it in the same
change-set.

## Work items: `feature_list.json`

One object per work item in `features[]`:

| Field          | Meaning                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| `id`           | Kebab-case, unique, stable (`issue-189-tls-reload`, `release-2.9.22`).                                   |
| `name`         | Short title.                                                                                             |
| `description`  | What the item delivers, including its acceptance criteria or checklist.                                  |
| `dependencies` | Ids that must be `done` first.                                                                           |
| `status`       | `not-started`, `in-progress`, `blocked` or `done`.                                                       |
| `evidence`     | Required for `done`: commands run, exact totals, artifact paths, commit, skeptic verdict.               |
| `issue`        | Optional GitHub issue number (`null` when there is none).                                                |
| `branch`       | Required for `in-progress`: the branch that owns the item, written without any account/user prefix (`tls-sighup-reload`, not `<user>/tls-sighup-reload`). At most one `in-progress` item per branch. |

## Parallel worktrees

Many sessions work at once, each in its own worktree and branch, and all of them
merge into `main`. The state files are shared, so they are written to merge
cleanly, and their conflicts have one fixed resolution:

- `feature_list.json`: a session edits only its own item's object and inserts a new
  item at its id-sorted position (the contract checks the order), so two sessions
  rarely touch adjacent lines. On a rebase conflict keep both items; ids stay
  unique (rename the new id if two sessions chose the same one).
- `progress.md`: a session edits only its own item's lines in Current State and
  prepends its Session Log entry under the heading. On a rebase conflict the
  `**Last Updated:**` line takes the newest date, and the Session Log keeps both
  entries, newest first. There is no single "active item" line: the items in
  progress are the `in-progress` entries of `feature_list.json`.
- No work item, progress note or handoff authorizes a commit, push, version bump,
  release or publication; only the user's explicit request does.

## `init.sh`

`./init.sh` prints the directory, branch (`(detached)` without one) and `HEAD`;
fails when `bun --version` differs from `BUN_VERSION` in
`.github/workflows/ci.yml`; then runs `bun install --frozen-lockfile --ignore-scripts`,
`bun run typecheck`, `bun run format:check`, `git diff --check` and
`git diff --cached --check`, and `bun test test/agent-harness` (both contract
files), and prints the work items in progress, blocked or ready and the next
steps. It stops at the first failure (`set -euo pipefail`). Where there is no Git
checkout rooted at the repository (a sanitized OrbStack Machine snapshot has no
`.git`) it skips the git steps with a notice instead of failing. It writes ignored
output only: `node_modules` from `bun install`, and `sdk/typescript/dist`, `dist`
and `docs/node_modules` from the `typecheck:prepare` step. `./init.sh --full` also
runs `bun run test:sandbox`. It is not a commit gate (`bun run test:sandbox` is),
but a green run is part of the Definition of Done; it replaces no gate in
[testing.md](../testing.md).

## Contract

`test/agent-harness-instructions.test.ts` and `test/agent-harness-state.test.ts`
(helpers in `test/agent-harness-support.ts`) run in the unit suite, alone with
`bun test test/agent-harness`, and fail, naming the file and the rule, when the
harness rots:

- `CLAUDE.md` and `AGENTS.md` stay at or below 12 KiB, keep the Startup Workflow,
  Definition of Done and End of Session sections, route to the four state and
  verification artifacts, keep "One work item at a time" and "Stay in scope", and
  keep every listed mandatory invariant (whitespace-normalized): the gates
  (`bun run test:sandbox` is matched on its own, so `test:sandbox:sdk` cannot stand
  in for it), the skeptic semantics (`` `FAIL` blocks ``, `` `CONDITIONAL` requires ``),
  the push and release authorization phrases, the no-authorization-from-state-files
  rule, the parallel-worktree conflict rules and the branch-prefix rule;
- every relative link of `CLAUDE.md`, `AGENTS.md`, `progress.md`,
  `session-handoff.md` and `docs/agents/*.md` resolves, and every `#anchor` names a
  real heading of its target (GitHub-style slug, headings in code blocks ignored);
- `feature_list.json` items are well formed (ids, statuses, evidence for `done`,
  a branch for `in-progress`) and in id order, dependencies exist, form no cycle,
  and a `done` item depends only on `done` items; at most one `in-progress` item
  per branch;
- `progress.md` has Current State, Blockers and Next sections and a
  `**Last Updated:** YYYY-MM-DD` line; `session-handoff.md` has every handoff
  section;
- `init.sh` is an executable bash script with `set -euo pipefail` that reads the
  Bun version from CI and runs the Bun-native checks only;
- no harness file is packed by the package.json `files` list (each pattern is
  evaluated with `Bun.Glob`, directories and `!` negations included), and
  `Dockerfile.test` copies every file the contract reads, so the sandbox unit
  container sees what the host sees.

`Dockerfile.test` copies the harness files and `docs/agents/` into the test image,
and `Dockerfile.test.dockerignore` allow-lists them.

Structural score, measured with the course's read-only `validate-harness.mjs`
(`--target <repo>`; not vendored here): 32/100 before the harness, 100/100 after.
It scores structure only, not how well agents work with it.
