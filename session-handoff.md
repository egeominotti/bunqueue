# Session Handoff

Template for a handoff note. For work that spans sessions, copy these sections into
your dated entry in the [`progress.md`](progress.md) Session Log (newest first)
instead of keeping a separate file, so parallel worktrees merge cleanly. Keep it
short and factual: commands and exact totals, not impressions. A handoff never
authorizes a commit, push, version bump, release or publication; only the user's
explicit request does. Harness overview: [docs/agents/README.md](docs/agents/README.md).

## Current Objective

- Work item: `<id>` from [`feature_list.json`](feature_list.json) (issue `#<n>` if any)
- Goal:
- Current status: not-started | in-progress | blocked | done
- Branch (no account/user prefix) / worktree / last commit:

## Completed This Session

- [ ]

## Verification Evidence

Record only what actually ran. A gate that was not run is a blocker, not a pass.

| Check                       | Command                                     | Result (exact totals, exit code) | Notes / artifacts                          |
| --------------------------- | ------------------------------------------- | -------------------------------- | ------------------------------------------ |
| Startup check               | `./init.sh`                                 |                                  | duration                                   |
| Focused tests               | `BUNQUEUE_EMBEDDED=1 bun test <file>`       |                                  | reproducing test failed before the fix?    |
| Model (when triggered)      | `bun run test:model`                        |                                  | seed / path / size on failure              |
| Full gate (any code change) | `bun run test:sandbox`                      | unit / tcp / embedded            | `artifacts/test-sandbox/<timestamp>/`      |
| SDK gate (`sdk/` changed)   | `bun run test:sandbox:sdk`                  |                                  | `artifacts/test-sandbox-sdk/<timestamp>/`  |
| Type check                  | `bun run typecheck`                         |                                  | `bun check` only                           |
| Format                      | `bun run format:check`                      |                                  | `bun fmt` only                             |
| Whitespace                  | `git diff --check`                          |                                  |                                            |
| Release Machines            | Ubuntu 24.04 + Debian 13 OrbStack Machines  |                                  | per [docs/testing.md](docs/testing.md)     |
| Review                      | `skeptic` agent                             | PASS / CONDITIONAL / FAIL        | before commit and before push              |
| CI after a push             | `ci-watch.sh --sha <sha>`                   | exit code, run id, attempt       | a flake's work item; red is a blocker      |

## Files Changed

- `path` — what changed and why

## Decisions Made

- **Decision**: context, alternatives considered

## Blockers / Risks

- Blocker or risk: impact, what unblocks it, who can

## Next Session Startup

1. Confirm the worktree and branch: `pwd`, `git branch --show-current`.
2. Read `CLAUDE.md` (Claude Code) or `AGENTS.md` (Codex).
3. Run `./init.sh` and repair a failing baseline before adding scope.
4. Read `feature_list.json` and the `progress.md` Current State and newest Session
   Log entry, including this handoff.
5. Review `git log --oneline -5`.

## Recommended Next Step

- The single next action, with the command to run first.
