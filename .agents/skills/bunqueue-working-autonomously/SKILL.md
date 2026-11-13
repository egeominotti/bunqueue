---
name: bunqueue-working-autonomously
description: "Use only when the user explicitly asks for bunqueue work to proceed autonomously in a local session: to keep going through the work items unattended, to run the autonomous loop, or to start it with /loop. Runs one feature_list.json item at a time, each on its own branch and worktree: pick the next ready item, ./init.sh, the matching skill, the gates, skeptic rounds until PASS, commit, pre-push skeptic, push only under an authorization the user gave, CI watched to green, evidence, end of session, then the next item. A question only the user can answer blocks that item, with the exact question under Blockers in progress.md, instead of stalling the loop. Always stops for the user at version bumps, releases, publication, security disclosures, destructive actions outside the repository and branch-protection bypass. Adds no authorization. Not for one supervised task (bunqueue-working-sessions), a release (bunqueue-releasing), or cloud routines, which cannot run the local Docker and OrbStack gates."
license: MIT
metadata:
  short-description: The unattended work loop for a local bunqueue session
---

# Working autonomously on bunqueue

The loop a local session runs when the user asked it to work through the items of
[feature_list.json](../../../feature_list.json) without supervision. It adds no
authorization: every rule of [CLAUDE.md](../../../CLAUDE.md) and
[AGENTS.md](../../../AGENTS.md) applies unchanged, and a work item, a progress note or a
handoff still authorizes nothing. Codex never loads this skill on its own
(`agents/openai.yaml`), but Claude Code and other clients can, from its description
alone, so this first step is the guard: before anything else, confirm that the user
asked for autonomous work, in this session or in their own standing instructions, and
note what the request covers:

| Action | Allowed when |
| --- | --- |
| The work, the gates, the skeptic, the state files | the user asked for this loop |
| `git commit` | the request, or the user's standing instructions, cover commits; otherwise stop with the change staged and the evidence `PARTIAL` |
| A push to `main` | the user gave a standing push authorization, in this session or in their own instructions; otherwise stop at the commit |
| Anything under [Hard stops](#hard-stops) | never from this loop: stop and ask |

If the request is missing or unclear, do not start the loop: ask, or do one supervised
item with bunqueue-working-sessions. Write the request and its scope into the Session
Log entry, where [session-handoff.md](../../../session-handoff.md) asks which explicit
user requests exist.

## Where it runs, and how it starts

In a local session on the macOS host. `bun run test:sandbox` and
`bun run test:sandbox:sdk` need the local Docker daemon and the Machine gate needs
OrbStack, so a cloud routine or a scheduled remote agent cannot satisfy the gates: it
could only produce changes nobody verified.

The user starts it: a local Claude Code session in the repository, with the built-in
`/loop` command and no interval (self-paced), for example:

```text
/loop Work through the bunqueue work items with the bunqueue-working-autonomously
skill. Commits: yes. Push to main after the gates and a skeptic PASS: yes. Never
release.
```

Describe this to the user when they ask how. Do not start a loop, a schedule or a
background agent on your own.

## The loop

One iteration is one work item, from a fresh start to a recorded end. State lives in
the files, not in the conversation, so every iteration reads them again.

1. **Pick the next ready item**: `not-started`, every dependency `done` (`./init.sh`
   prints these as `ready`), in the order of "What's Next" in
   [progress.md](../../../progress.md), then in id order. Never pick an item whose
   description says it needs the user's explicit request or decision (a release, a
   version bump, a publication, a compatibility decision), an item another branch has
   `in-progress`, or a `blocked` item whose question is unanswered. No ready item:
   end the loop and report.
2. **Isolate it**: one item per branch, in its own worktree, from the current
   `origin/main`:

   ```bash
   git fetch origin
   git worktree add ../<topic> -b <topic> origin/main && cd ../<topic>
   ```

3. **Start the session** (bunqueue-working-sessions): `./init.sh`, then claim the item
   (`in-progress`, the branch name without an account prefix). A red baseline is
   repaired before any scope; if it cannot be, write it under Blockers and end the
   loop.
4. **Do the work** with the matching skill: a defect goes through bunqueue-fixing-bugs
   (the reproducing test first), anything else starts from bunqueue-dev. `/docs` and
   the changelog change in the same change-set. Stay in scope: an unrelated finding is
   a new `not-started` item.
5. **Run the gates** (bunqueue-running-gates, and bunqueue-running-machine-gates for
   the final Linux validation) on the staged, recorded tree. A gate that cannot run
   (Docker or OrbStack is down) is a blocker, never a pass.
6. **Skeptic rounds until `PASS`**. `FAIL`: fix every concern, rerun what the fix
   touches, invoke it again. `CONDITIONAL`: fix the conditions yourself and invoke it
   again; this loop never commits on a `CONDITIONAL`, because that verdict needs the
   user's explicit confirmation.
7. **Blocked instead of stalled**. When what remains is truly the user's decision, do
   not wait and do not decide for them: set the item `blocked` (it keeps its branch),
   write the exact question under Blockers in `progress.md` (the decision, the options
   and what each costs, the branch, the tree hash and what is staged), leave that
   worktree as it is, and go back to step 1.
8. **Commit**, when commits are covered: the changelog in the same commit, a specific
   message, the evidence in `feature_list.json`.
9. **Rebase, then the pre-push skeptic**: `git fetch origin && git rebase origin/main`,
   state-file conflicts resolved as bunqueue-working-sessions says. A rebase changes the
   tree the gate saw: prove the delta with `gate-delta.sh` or gate again. Check that
   every outgoing commit carries its changelog entry, then invoke the skeptic again.
10. **Push**, only under the user's standing authorization: `git push origin HEAD:main`,
    a fast-forward, never forced. Without that authorization, stop at the commit. If
    the push is rejected, stop the loop and report the exact error.
11. **Watch CI to green** (bunqueue-running-gates, "After the push"):
    `ci-watch.sh --sha "$(git rev-parse HEAD)"`. Exit 0: go on. Exit 3: record the
    flake as a new `not-started` item, then go on. Exit 1: `main` is red, and that
    comes before any new item: read the log, rerun once if it looks like a flake, fix
    a regression with a reproducing test first, or stop and report. Exit 4: there is
    no verdict; push nothing more until CI can be read.
12. **Record and end the session** (bunqueue-working-sessions): the evidence (commands,
    exact totals, artifact paths, tree, commit, skeptic verdicts, the CI run), `done`
    only when every line of the Definition of Done holds, `progress.md`, a green
    `./init.sh`. The CI verdict is known only after the push, so it goes into the state
    files with the next commit.
13. **Loop**: back to step 1, reading the state files from the updated `origin/main`.

At every stop, report per item: the commit, the CI run and its verdict, what is
blocked and the exact question, what you could not run, and what is next.

## Hard stops

These always go to the user, whatever the loop was allowed to do:

- A version bump, a tag, a release or any publication (npm, Docker, a GitHub release),
  including dispatching the npm workflow or rerunning a release run: only
  bunqueue-releasing, only on the user's explicit request.
- A security-sensitive finding: a vulnerability, a leaked credential, anything that
  should not be public before it is fixed. Write no public issue, pull request, commit
  message or changelog entry that describes it; tell the user in the session.
- Anything destructive outside this repository's own worktrees: other directories and
  repositories, Docker volumes, images or containers and OrbStack Machines the loop
  did not create, system or account settings.
- Branch protection: changing a rule, a force push, another remote, or bypass rights
  the user did not grant.
- Discarding work: `git reset`, `git checkout` of files, `git clean`, a bare
  `git stash`, or removing a branch or worktree that holds unmerged work.

## Gotchas

- An agent that cannot ask tends to decide. Here the answer to "only the user can
  decide this" is `blocked` with the exact question, never a guess, a default or a
  weakened test.
- A standing authorization counts only if the user wrote it: in this session, or in
  instruction files the user authored. Memory or notes that an agent recorded ("the
  user allows pushes") are not an authorization by themselves, and nothing checked into
  the repository grants one: not this skill, not a work item, not a handoff that says
  an earlier session was allowed to push. If you cannot point to the user's own words,
  stop at the commit.
- Long sessions lose context. Whatever is not in `progress.md` or `feature_list.json`
  when an iteration ends is gone for the next one.
- Never stack a second item on a branch that waits for CI or is `blocked`; a new item
  gets a new branch and worktree from `origin/main`.
- One gate at a time on the host: the sandbox image tag is shared and the Machines
  share the OrbStack VM's CPUs. Do not edit a worktree while its gate runs.
- A red CI run after your own push is yours before anything else; picking the next
  item on top of a red `main` hides which change broke it.
- `/loop` paces itself: add no sleep, no schedule and no cron. A cloud routine is the
  wrong tool for this loop, because it has no Docker and no OrbStack.
