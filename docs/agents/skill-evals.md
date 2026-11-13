# Skill Trigger Evals (agents)

Whether an agent loads the right [Agent Skill](./README.md#skills) for a request depends
on one line: the `description` in the skill's frontmatter. This page is how that line is
measured with real agent CLIs, what was measured on 2026-11-13, and when to measure
again. The runner is
[scripts/agents/run-skill-evals.ts](../../scripts/agents/run-skill-evals.ts); the
queries are the `trigger_queries` of each `.agents/skills/<name>/evals/evals.json`,
whose shape [test/agent-skills.test.ts](../../test/agent-skills.test.ts) checks. Index:
[docs/agents/README.md](./README.md).

## Run

```bash
bun scripts/agents/run-skill-evals.ts --dry-run                # planned commands, runs nothing
bun scripts/agents/run-skill-evals.ts --limit 0                # discovery check only
bun scripts/agents/run-skill-evals.ts --skill bunqueue-dev     # one skill, 18 sessions
bun scripts/agents/run-skill-evals.ts                          # every skill, Claude Code
bun scripts/agents/run-skill-evals.ts --agent codex --limit 3  # 3 + 3 queries per skill
```

| Option | Meaning |
| --- | --- |
| `--agent claude\|codex\|gemini` | the CLI to drive (default `claude`) |
| `--skill <name>` | only this skill's queries; repeatable |
| `--limit <n>` | at most `n` should-trigger and `n` should-not queries per skill; `0` runs the discovery check only |
| `--concurrency <n>` | parallel sessions (default 3) |
| `--max-turns <n>` | Claude Code turn cap per session (default 2) |
| `--timeout <seconds>` | wall-clock cap per session (default 240) |
| `--dry-run` | print the planned commands and exit |

`SKILL_EVALS_CLAUDE_BIN`, `SKILL_EVALS_CODEX_BIN` and `SKILL_EVALS_GEMINI_BIN` replace
the launcher (for example `"mise exec node@24.21.0 -- gemini"` when the shim of the
active Node version does not provide the CLI).

Each query runs in a fresh headless session started from the repository root. The
runner prints one line per session, a per-skill summary and every miss and false
trigger, and writes `artifacts/skill-evals/<timestamp>/report.json` (git-ignored) with
the agent version, the exact session command, the discovery result, every description
as measured, the summary and every outcome, plus the raw event stream of each session
under `sessions/`. It exits 1 when a skill that should be listed is not, or when five
sessions in a row fail; it stops scheduling sessions at that point.

Report fields per skill: `shouldTrigger.hit/total`, `shouldNot.fired/total`, `readOnly`
(see the Claude Code signal below), `insteadOnMiss` (which skills loaded on a miss,
`none` when no skill did), `loadedOnOtherSkillsQueries` (loads of this skill during the
other skills' queries, legitimate or not) and `errors`. A session with status `error`
never reached an answer (authentication, rate limit, crash) and is excluded from every
rate; a `timeout` session is scored on what it loaded before the cap.

## Sessions are read-only

Discovery is a prerequisite: a failed, timed-out or incomplete discovery produces
a report and schedules no subscription sessions. Explicit-only skills may be
absent by their Codex policy. Session deadlines cover the owned process tree;
termination escalates when a CLI ignores SIGTERM or descendants keep its pipes
open. Codex loading is scored only for successful completed command events that
identify the canonical skill in this checkout; stale same-name user copies and
failed reads do not count. The historical measurements below retain their original
methodology and are not silently rescored by this change.

SIGTERM/SIGINT cancels active process groups and prevents further scheduling,
records the interruption and exits 143/130. Interrupted outcomes are excluded
from hit/miss rates. Termination uses a 100 ms grace before KILL. Process ownership
is implemented in `scripts/agents/skill-eval-process.ts`; CLI event and canonical
path handling are in `scripts/agents/skill-eval-agents.ts`. Shell-quoted and
backslash-escaped paths inside the current checkout retain their identity.

| Agent | Session command | Why it cannot change the repository or prompt |
| --- | --- | --- |
| Claude Code | `claude -p <query> --output-format stream-json --verbose --permission-mode plan --max-turns 2 --permission-prompts none --strict-mcp-config --tools Skill,Read,Grep,Glob --setting-sources project --no-session-persistence` | plan mode, no `Bash`, `Edit` or `Write` tool, and anything that would prompt is denied |
| Codex | `codex exec --json --sandbox read-only --ephemeral --ignore-user-config -c approval_policy="never" <query>` | read-only sandbox; the user config, which may widen the sandbox, is ignored |
| Gemini CLI | `gemini -p <query> -o stream-json --approval-mode plan --skip-trust` | plan mode is read-only |

The runner compares `git status --porcelain` before and after and records
`treeChanged`. On 2026-11-13 the runs made while nothing else edited the worktree left
it unchanged (2 + 18 + 18 Claude Code sessions and 30 Codex sessions, in which Codex
itself reported a read-only filesystem); the other runs overlapped a parallel edit of
the worktree, so their flag says nothing about the sessions.

Claude Code sessions load the project settings only (`--setting-sources project`), no
MCP servers, and no auto-memory (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`), so a personal
plugin cannot change the result: the `superpowers` plugin, for one, injects "use a skill
before any response" at session start. Codex and Gemini CLI cannot be isolated the same
way: both also list the user-level skills in `~/.agents/skills`.

## Detection signal per agent

- **Claude Code** (verified). A trigger is an `assistant` event whose content holds a
  `tool_use` block named `Skill`; `input.skill` is the skill. A `Read` of
  `<skill>/SKILL.md` is recorded separately as `read` and never scored: in the baseline
  it was sometimes the agent consulting the skill for a question about it, and
  sometimes a search hit after a `Grep`, and the stream cannot tell the two apart. A
  session is complete when its `result` event has subtype `success` or
  `error_max_turns`. Discovery: the `skills` array of the `system`/`init` event; the
  process is killed at that event.
- **Codex** (verified). Codex has no skill tool: it lists each skill with a path and
  reads the file with a shell command. A trigger is a successful completed
  `command_execution` item naming this checkout's canonical `<skill>/SKILL.md`;
  a successful `grep` over that file counts too, which cannot
  be avoided. There is no turn cap, so the window is the whole session. Discovery:
  `codex debug prompt-input x` renders the model-visible prompt without a model call.
  A skill whose `agents/openai.yaml` sets `allow_implicit_invocation: false` is absent
  from that listing by design; the runner reports it as explicit-only and runs none of
  its queries.
- **Gemini CLI** (discovery verified, trigger signal not verified). Discovery:
  `gemini skills list` with `GEMINI_CLI_TRUST_WORKSPACE=true`; without it an untrusted
  folder hides the project skills. The trigger signal is read from the 0.62.0 source,
  a `tool_use` stream event with `tool_name: "activate_skill"` and `parameters.name`,
  and no live session has confirmed it: the CLI on the measuring machine has no
  authentication method configured, so every session ends with exit code 41 before a
  model request. The runner reports such sessions as errors, never as misses.

## Cost guard

Every session spends the owner's subscription. Measured on 2026-11-13 over 272 runner
sessions of Claude Code at `--max-turns 2`: a mean of 13.1 seconds per session (median
12.4, longest 38.1) and a mean `total_cost_usd` of 0.314 as reported by the CLI, 85.33
in total (the list-price equivalent of what the subscription absorbed). Codex has no
turn cap: 30 sessions used 4,438,485 input tokens (cached tokens included) and 18,210
output tokens.

- Run each Claude Code query once: a full run is 18 sessions per skill.
- After a description change, re-run only the skills whose description or queries
  changed (`--skill`), not the whole set.
- For Codex and Gemini CLI, run the discovery check (`--limit 0`, no model call) and at
  most `--limit 3`.
- To tell noise from a real effect, repeat the one query a few times rather than the
  whole set: `--dry-run` prints its exact command.
- Read the first ten session lines. A systematic failure is a runner or login problem:
  stop and fix it instead of spending sessions.

## Results (2026-11-13)

macOS 27.2.1 arm64, Bun 1.4.4. Claude Code 2.1.323 with model `claude-fable-5-2`; Codex
`codex-cli 0.167.0` with its default model (user config ignored); Gemini CLI 0.62.0.
One run per query; every Claude Code session completed (status `ok`).

Discovery: Claude Code lists 7 of 7 skills; Gemini CLI lists 7 of 7; Codex lists 5 of 7,
the two missing being the explicit-only `bunqueue-releasing` and
`bunqueue-working-autonomously`. Codex shows each listed description in full (524 to
581 characters) in a listing of 62 skills and 17,864 characters, so no shortening was
observed on this machine.

### Claude Code, before and after

"Before" is the description at `3e08f75b` (and the first version of
`bunqueue-working-autonomously`); "after" is the description in the tree. `+n read`
counts sessions that opened the skill's `SKILL.md` with `Read` without a `Skill` call.

| Skill | Characters | Offset of "Use when" | Should-trigger hit | Should-not fired |
| --- | --- | --- | --- | --- |
| bunqueue-dev | 780 -> 581 | 268 -> 61 | 3/9 -> 9/9 | 1/9 -> 0/9 |
| bunqueue-fixing-bugs | 673 -> 553 | 282 -> 48 | 9/9 -> 9/9 | 0/9 -> 0/9 |
| bunqueue-releasing | 736 -> 616 | 404 -> 39 | 7/9 (+1 read) -> 9/9 | 0/9 (+1 read) -> 0/9 (+1 read) |
| bunqueue-running-gates | 820 -> 546 | 493 -> 55 | 7/9 (+1 read) -> 7/9 | 0/9 -> 0/9 |
| bunqueue-running-machine-gates | 782 -> 557 | 487 -> 70 | 6/9 (+1 read) -> 8/9 | 0/9 (+1 read) -> 0/9 |
| bunqueue-working-sessions | 742 -> 524 | 396 -> 51 | 8/9 -> 9/9 | 0/9 -> 0/9 |
| bunqueue-working-autonomously | 1006, unchanged | 0 | 7/9 (+2 read), not re-run | 0/9, not re-run |

Over the six rewritten skills: 40/54 -> 51/54 should-trigger hits and 1/54 -> 0/54
false triggers. Three of the `bunqueue-dev` should-trigger queries were replaced (see
below), all three old ones being misses; on the 51 should-trigger queries whose text
did not change the hits are 40/51 -> 48/51.

What the numbers do not show:

- The baseline `report.json` files predate the `read` rule: the first runner counted a
  `Read` of `SKILL.md` as a load. The "before" column is rescored from the saved
  session streams with the final rule; the "after" runs used it from the start.
- `bunqueue-dev` did not over-trigger before the change: in the baseline it loaded on
  2 of the other skills' 108 queries, a feature and a refactor, which no other skill
  owns. It under-triggered: on code-lookup questions the agent went straight to `Grep`.
  The first rewrite (552 characters, 9/9 and 0/9) loaded on 8 of the other skills' 90
  queries: three features, one refactor and four questions about the architecture, and
  never on another skill's should-trigger query (0 of 45). The final description adds
  one sentence (see Codex below); only its own 18 queries were run again.
- The first rewrite of `bunqueue-releasing` (552 characters) scored 9/9 and 2/9: it
  fired on "feature_list.json has a release-2.9.23 item, start on it" and on "publish
  the python SDK to PyPI from my laptop". Repeating the first query three more times
  fired once (2 of 4 in total). A second version that names the release work item as
  out of scope fired 0 of 4 times on that query and loaded `bunqueue-working-sessions`
  4 of 4 times. The final version also names an SDK's own publication as out of scope;
  its full re-run gave 9/9 and 0/9, with the PyPI query opening `SKILL.md` as a file.
- Three misses survive the rewrite, all of them requests the agent can answer by
  opening one file: "read artifacts/test-sandbox/... and tell me the totals for the
  evidence", "read artifacts/machines/.../manifest.md and summarize it for the
  evidence", and "docker isn't running on this machine, can I just run bun test
  --parallel=4 instead of the sandbox?" (answered from `CLAUDE.md`).
- `bunqueue-working-autonomously` was left as written: its description already starts
  with "Use only when", Codex never lists it, and both of its misses are questions
  about the loop, which the agent answered by reading the file instead of starting the
  loop.

Runs behind the table (each under `artifacts/skill-evals/` on the measuring machine):
`2026-11-13T01-32-38.173Z` (baseline, six skills, 108 sessions),
`2026-11-13T01-41-16.817Z` (baseline of `bunqueue-working-autonomously`, 18),
`2026-11-13T01-47-34.265Z` (after, six skills, 108), `2026-11-13T01-58-24.300Z` (final
`bunqueue-releasing`, 18) and `2026-11-13T02-06-24.608Z` (final `bunqueue-dev`, 18).

### Codex, after only

One run of `--limit 3`, 30 sessions, on the rewritten descriptions; there is no Codex
baseline, because the cost guard allows one such run.

| Skill | Should-trigger hit | Should-not fired |
| --- | --- | --- |
| bunqueue-dev | 3/3 | 0/3 |
| bunqueue-fixing-bugs | 3/3 | 0/3 |
| bunqueue-running-gates | 3/3 | 0/3 |
| bunqueue-running-machine-gates | 3/3 | 0/3 |
| bunqueue-working-sessions | 3/3 | 2/3 |
| bunqueue-releasing, bunqueue-working-autonomously | explicit-only, not run | explicit-only, not run |

- All 30 sessions first read the user-level `using-superpowers` skill, which tells the
  agent to load every skill that might apply. These rates are therefore an upper bound
  on triggering, measured in the owner's environment, not in a clean one.
- The window is the whole session. In the six sessions about a defect (the three
  `bunqueue-fixing-bugs` queries and three should-not queries of other skills) Codex
  read `bunqueue-fixing-bugs`, `bunqueue-dev` and `bunqueue-working-sessions`; in both
  feature queries it read `bunqueue-dev` and `bunqueue-working-sessions`. The two false
  triggers of `bunqueue-working-sessions` are such tasks ("fix the bug in the unix
  socket rollback", "write a progress bar for the CLI push command"): Codex starts a
  session before it changes code.
- The run measured the 552-character `bunqueue-dev` description. The sentence "Skip it
  for a bug fix, a gate, a Machine run, a release or a session" was added afterwards,
  because of the co-loading above; its effect on Codex is not measured.

### Gemini CLI

Discovery only: 7 of 7 skills listed. No trigger rate exists for Gemini CLI.

## Queries changed

Only `bunqueue-dev` queries changed, all should-trigger, all replaced rather than
relabelled. Each old query has an answer the agent already holds without any skill, so
"the skill should load" was not a meaningful expectation.

| Removed | Why | Replaced by |
| --- | --- | --- |
| "what's the lock order for shards and processing shards here?" | `CLAUDE.md`, always in context, states the lock hierarchy in one line; the agent quoted it | "give me a tour of the bunqueue source tree before I start contributing: which directory holds what?" |
| "which skill should I use to validate my change before committing in bunqueue?" | the skill listing in context answers it, and the skill to load, if any, is `bunqueue-running-gates` | "I'm changing a TCP command and its docs page in bunqueue and I'm not sure which procedure applies. what do I read first?" |
| "is there a max file length rule in this repo?" | `CLAUDE.md` states the 300-line rule | "I'm adding a new manager under src/application in bunqueue: which conventions and which docs pages do I have to follow?" |

"publish the python SDK to PyPI from my laptop" stays a should-not query of
`bunqueue-releasing`, although it is a borderline one: it is an explicit publication
request, and the rule that forbids it lives in the release reference.

## Known limits

- One run per query is noisy. The same query with the same description fired in 2 of 4
  sessions. A difference of one query out of nine between two runs is not evidence;
  repeat that query before acting on it.
- Nine queries per class give a resolution of 11 percentage points, and the queries
  were written by the same hands as the descriptions.
- The Claude Code window is two turns, the Codex window the whole session: the rates of
  the two agents are not comparable, and a skill an agent would load on its third turn
  is a miss for Claude Code here.
- The 2026-11-13 "before" and "after" differ in more than the descriptions:
  `bunqueue-working-autonomously` appeared in the listing during the last 4 baseline
  sessions, `CLAUDE.md` and `AGENTS.md` were being reworded by a parallel change until
  01:42 UTC (before every "after" run), and the "after" rows of the four skills that
  were not re-run a second time were measured with the intermediate `bunqueue-dev` and
  `bunqueue-releasing` descriptions in the listing.
- A trigger is the CLI-specific loading signal described above, not a filesystem
  read trace or proof that the agent followed the skill. The output scenarios
  (`evals` in `evals.json`) are not run by this script.
- No thresholds are enforced. As a working rule, investigate a skill below 7/9
  should-trigger hits, and any should-not query that fires again when repeated.

## When to re-run

- After any change to a `description` line: that skill, plus the skills its
  description names or that share its trigger words.
- After adding or removing a skill: the new skill, plus one full Claude Code run,
  because every listing changes.
- After changing `trigger_queries`: that skill.
- After a major version of an agent CLI: the discovery check (`--limit 0`) for all
  three, then `--limit 3`, since the event format this script reads can change.
- When Gemini CLI is authenticated on the measuring machine: `--agent gemini --limit 3`,
  to confirm the trigger signal before any rate is quoted.

Record the date, the agent versions and the exact counts here; never a rounded or
estimated figure.
