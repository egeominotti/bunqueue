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
| [skill-evals.md](./skill-evals.md)               | new                            | How the skill trigger evaluations are run against real agent CLIs, their cost, and the measured rates. |
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
| `evidence`     | Required for `done`: commands run, exact totals, artifact paths, commit, skeptic verdict, and after a push the CI run. The contract rejects `done` evidence that names no command, or neither an artifact path nor a commit or tree hash. |
| `issue`        | Optional GitHub issue number (`null` when there is none).                                                |
| `branch`       | Required for `in-progress`: the branch that owns the item, written without any account/user prefix (`tls-sighup-reload`, not `<user>/tls-sighup-reload`). At most one `in-progress` item per branch. |

## Parallel worktrees

Many sessions work at once, each in its own worktree and branch, and all of them
merge into `main`. The state files are shared, so they are written to merge
cleanly, and their conflicts have one fixed resolution:

- Branch names: committed files carry the branch without its account prefix, so two
  people's branches can share a name, and the one-item-per-branch check then reads
  them as one branch. The convention is `<topic>`, plus a short unique suffix
  (`tls-sighup-reload-k7`) whenever another contributor may pick the same topic.
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
`git diff --cached --check`, and the fast harness and [skills](#skills) contracts
(`bun test test/agent-harness` plus the skills tests listed in the script, in
parallel), and prints the work items in progress, blocked or ready, the agent skills
and the next steps. It stops at the first failure (`set -euo pipefail`) and takes about
10 s. The Machine lifecycle and worker contracts
(`test/agent-skills-machine-lifecycle.test.ts` and
`test/agent-skills-machine-worker.test.ts`, about 50 s of real process trees, settle
windows and time bounds) are left to the unit suite, which
`bun run test:sandbox` runs; `test/agent-harness-init.test.ts` fails when a contract
test is neither run by `init.sh` nor on that short list.

It asks Git whether the directory is the root of a checkout (`git rev-parse
--show-prefix` is empty), which also holds for a worktree, whose `.git` is a file, and
for a path typed in another case on a case-insensitive volume. Where it is not (a
sanitized OrbStack Machine snapshot has no `.git`) it skips the git steps with a notice
instead of failing. `./init.sh --workspace` prints the directory, branch and `HEAD` and
stops. It writes ignored output only: `node_modules` from `bun install`, and
`sdk/typescript/dist`, `dist` and `docs/node_modules` from the `typecheck:prepare` step.
`./init.sh --full` also runs `bun run test:sandbox`. It is not a commit gate
(`bun run test:sandbox` is), but a green run is part of the Definition of Done; it
replaces no gate in [testing.md](../testing.md).

## Contract

`test/agent-harness-instructions.test.ts`, `test/agent-harness-state.test.ts` and
`test/agent-harness-init.test.ts` (helpers in `test/agent-harness-support.ts`) run in
the unit suite, alone with `bun test test/agent-harness`, and fail, naming the file and
the rule, when the harness rots:

- `CLAUDE.md` and `AGENTS.md` stay at or below 12 KiB, keep the Startup Workflow,
  Definition of Done and End of Session sections, route to the four state and
  verification artifacts, keep "One work item at a time" and "Stay in scope", and
  keep every listed mandatory invariant (whitespace-normalized): the gates
  (`bun run test:sandbox` is matched on its own, so `test:sandbox:sdk` cannot stand
  in for it), the skeptic semantics (`` `FAIL` blocks ``, `` `CONDITIONAL` requires ``),
  the push and release authorization phrases, the no-authorization-from-state-files
  rule, the parallel-worktree conflict rules, the branch-prefix rule, and the CI rule
  (a green CI run on the pushed commit in the Definition of Done, a flaky job rerun
  once and turned into a work item, and watching CI in End of Session);
- every relative link of `CLAUDE.md`, `AGENTS.md`, `progress.md`,
  `session-handoff.md` and `docs/agents/*.md` resolves, and every `#anchor` names a
  real heading of its target (GitHub-style slug, headings in code blocks ignored;
  inline code is skipped by backtick-run length, so a double-backtick span that holds
  single backticks hides no link and invents none);
- `feature_list.json` items are well formed (ids, statuses, evidence for `done`,
  a branch for `in-progress`) and in id order, dependencies exist, form no cycle,
  and a `done` item depends only on `done` items; at most one `in-progress` item
  per branch; the evidence of a `done` item names at least one command and either an
  artifact path or a commit or tree hash (a floor that keeps "all green" from closing
  an item, not a measure of the evidence);
- `progress.md` has Current State, Blockers and Next sections and a
  `**Last Updated:** YYYY-MM-DD` line; `session-handoff.md` has every handoff
  section;
- `init.sh` is an executable bash script with `set -euo pipefail` that reads the
  Bun version from CI and runs the Bun-native checks only; it detects the root of a
  checkout, also through a differently cased path, skips the git steps in a directory
  that is not one, and runs every contract test except the listed slow ones;
- no harness file is packed by the package.json `files` list (each pattern is
  evaluated with `Bun.Glob`, directories and `!` negations included), and
  `Dockerfile.test` copies every file the contract reads, so the sandbox unit
  container sees what the host sees. The `COPY` reader joins backslash-continued
  lines and throws, quoting the instruction, on a form it cannot read (the JSON form,
  a heredoc, `--from`), instead of passing on a source it never saw.

`Dockerfile.test` copies the harness files and `docs/agents/` into the test image,
and `Dockerfile.test.dockerignore` allow-lists them. The skills have a contract of
their own, described under [Skills](#skills).

Structural score, measured with the course's read-only `validate-harness.mjs`
(`--target <repo>`; not vendored here): 32/100 before the harness, 100/100 after.
It scores structure only, not how well agents work with it.

## Skills

Procedures an agent needs only for some tasks are Agent Skills (the agentskills.io
format) in [`.agents/skills/`](../../.agents/skills/), the directory Codex, Gemini CLI,
Cursor and Copilot read. Claude Code reads only `.claude/skills/`, so every skill also
has one relative symlink there: `.claude/skills/<name>` -> `../../.agents/skills/<name>`.
A skill encodes a procedure and its gotchas and links to `CLAUDE.md`, `AGENTS.md` and
the pages above for the rules; it never restates or overrides a rule.

| Skill | For |
| --- | --- |
| [bunqueue-dev](../../.agents/skills/bunqueue-dev/SKILL.md) | orientation: architecture, source layout, conventions, routing to the other skills |
| [bunqueue-working-sessions](../../.agents/skills/bunqueue-working-sessions/SKILL.md) | session start and end, work items, `progress.md`, handoff, Definition of Done evidence |
| [bunqueue-fixing-bugs](../../.agents/skills/bunqueue-fixing-bugs/SKILL.md) | reproduce first, subagents, docs and changelog, skeptic rounds until `PASS` |
| [bunqueue-running-gates](../../.agents/skills/bunqueue-running-gates/SKILL.md) | which gate a change needs, sandbox artifacts and KPIs, failure classification, `scripts/gate-delta.sh` for post-gate deltas, and after a push `scripts/ci-watch.sh`: a bounded, read-only wait for the CI run (exit 0 green, 1 failed, 3 green only after a rerun, 4 no verdict) |
| [bunqueue-running-machine-gates](../../.agents/skills/bunqueue-running-machine-gates/SKILL.md) | the OrbStack Machine gate (`scripts/machine-gate.sh` and its helpers), cleanup on every exit path, the known node gap (exit 3) |
| [bunqueue-releasing](../../.agents/skills/bunqueue-releasing/SKILL.md) | a release, only on the user's explicit request; Codex never invokes it implicitly, Claude Code can, so its first step stops without that request; the release is done only when the version gate, tag, GitHub release, Docker images and npm are verified |
| [bunqueue-working-autonomously](../../.agents/skills/bunqueue-working-autonomously/SKILL.md) | the unattended work loop of a local session, only on the user's explicit request (same guard): one ready item per branch and worktree, gates, skeptic until `PASS`, commit, push only under the user's own standing authorization, CI watched to green, `blocked` with the exact question instead of a stall, and the hard stops that always go to the user. It adds no authorization, and a cloud routine cannot run it: the gates need local Docker and OrbStack |

The root `skills/bunqueue/` and `agents/` directories are something else: the Claude
Code plugin (`.claude-plugin/plugin.json`) for applications that use bunqueue.

On Windows, Git checks the `.claude/skills/` symlinks out as plain text files unless
symlinks are enabled, and Claude Code then finds no skill there; clone with
`git clone -c core.symlinks=true` (symlinks need Developer Mode or an elevated shell).
`.agents/skills/` itself holds no symlink.

A skill directory holds only:

- `SKILL.md`: the portable frontmatter keys `name` (the directory name: 1-64
  characters of `a-z`, `0-9` and inner single hyphens, without `anthropic` or
  `claude`), `description` (one quoted line of at most 1024 characters without `<` or
  `>`: what the skill does, then "Use when ...", and when not to use it), and
  optionally `license` and string-valued `metadata`; then a body under 500 lines with a
  Gotchas section;
- `references/`: details one level deep, each linked from `SKILL.md`, with a Contents
  section when longer than 100 lines;
- `scripts/`: deterministic, non-interactive bash in strict mode, compatible with the
  bash 3.2 of macOS, at most 300 lines each, with `--help`, `--dry-run`, distinct exit
  codes and diagnostics on stderr, each linked from `SKILL.md`; `assets/`: data the
  scripts read;
- `agents/openai.yaml` (optional): Codex metadata; a skill that runs only on the user's
  explicit request sets `policy.allow_implicit_invocation: false`;
- `evals/evals.json`: trigger and output evaluations in a reduced form of the
  anthropics/skills skill-creator format:

```json
{
  "skill_name": "bunqueue-fixing-bugs",
  "trigger_queries": [
    { "query": "a realistic request", "should_trigger": true },
    { "query": "a near miss for another skill", "should_trigger": false, "note": "why" }
  ],
  "evals": [
    {
      "id": 1,
      "prompt": "a task",
      "expected_output": "what a good run does",
      "assertions": ["a checkable statement about the run"],
      "files": []
    }
  ]
}
```

with at least 8 queries that should trigger the skill, at least 8 near misses that
share its words but belong to another skill or to none, and at least 3 output
scenarios. The contract checks their shape. The trigger queries are run against real
agent CLIs with `bun scripts/agents/run-skill-evals.ts` (read-only headless sessions;
`--dry-run` prints the plan and starts none): how, what it costs, and the rates
measured on 2026-11-13 are in [skill-evals.md](./skill-evals.md). The output scenarios
are still run by hand.

`test/agent-skills.test.ts`, `test/agent-skills-scripts.test.ts`,
`test/agent-skills-ci-watch.test.ts`, `test/agent-skills-evals-runner.test.ts`,
`test/agent-skills-machine-gate.test.ts`, `test/agent-skills-machine-worker.test.ts` and
`test/agent-skills-machine-lifecycle.test.ts` (helpers in `test/agent-skills-support.ts` and
`test/agent-skills-fakes.ts`; `bun test test/agent-skills`) run in the unit suite and
fail, naming the skill and the rule, when a skill rots: the layout and the symlinks,
the frontmatter, name and single-line description rules, every link resolving inside
the repository (anchors included), every bundled file linked, the evals shape, the
Codex invocation rule (and, for a skill Codex may not invoke implicitly, the guard its
first step opens with), strict-mode scripts of at most 300 lines whose `--help`, usage
error and `--dry-run` behave (the dry run with every side-effecting command replaced by
a recorder that must stay empty), the post-gate delta on listed paths and, where Git
is installed, on a real repository with a rename, the Machine gate's verdicts on
fixture logs and its list of known failures, its cleanup with a fake OrbStack (an
interrupt during `orb create` leaves no Machine and no worker, a create that appears
too late is reported as not deleted, an existing Machine name is never touched, a
failing `orb list` is a failure, only the gate's own live workers are signalled, a burst
of SIGINT to the gate's process group during cleanup still copies the logs and deletes
every Machine, a failed `orb delete` is retried and its exit codes recorded), one worker
against a fake Machine (every step printed with its exit code, the Machine-side content
hash, the time bound on `orb create` and on the copy), the trigger-eval runner's `--help`
and `--dry-run` (no agent session, no report; the runner type checks), the
CI watcher's verdicts against a fake `gh` that answers from GitHub-shaped fixtures (green,
failed with its jobs, green only after a rerun, cancelled, waiting for an approval, no
run, a timeout, a failing `gh`; only `gh run list` and `gh run view` are ever called),
no skill file in the npm package, and every skill file and link
target in the sandbox test image (`Dockerfile.test` copies `.agents/` and
`.claude/skills/`, symlinks kept as symlinks).
