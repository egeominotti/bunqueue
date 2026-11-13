# Briefs for the fix subagents and the skeptic

A subagent knows only its brief. These templates carry what past sessions had to send
again after a first round came back without it. Fill every angle-bracket field; drop a
line only when it does not apply.

## Fix subagent

```text
Goal: make <test path> pass by fixing the bug it reproduces in bunqueue, without
editing that test.

Bug: <one paragraph: symptom, how to trigger it, issue number>.
Reproducing test: <path>. It fails today with:
<the failure output, trimmed to the assertion and its stack>

Likely area: <files or modules>. Ruled out: <what you checked and why it is not that>.

Constraints (CLAUDE.md / AGENTS.md):
- smallest change that fixes this bug; no refactoring outside it;
- source files stay at or below 300 lines (split instead of growing one);
- lock hierarchy jobIndex -> completedJobs -> shards[N] -> processingShards[N],
  locks released in finally, no await inside a shard critical section;
- queue invariants (heap membership, jobIndex, processing maps, counters, temporal
  indexes, group ownership, concurrency slots) transition exactly once;
- no behavior change beyond the bug; name any you cannot avoid;
- Bun-native tooling only: bun run typecheck, bun fmt.

Report: the diff, why it fixes the cause (not the symptom), the commands you ran with
exact totals (the reproducing test, the neighbouring test files, bun run typecheck),
and anything you could not verify.
```

For competing hypotheses, send the same brief with a different "Likely area" and
"Hypothesis" line to each subagent, in parallel, and compare their evidence.

## Skeptic

Stage the whole change first (`git add`), then:

```text
Review the staged diff before a <commit | push> (bunqueue, CLAUDE.md / AGENTS.md
rules). Read the complete `git diff --staged`; identify at least three potential
failure points per changed file; check races, error handling, idempotency, type
safety, test coverage and the docs/changelog of the change.

Change: <one paragraph>. Work item: <id>, branch <name without account prefix>.
Reproducing test: <path>; before the fix: <failure line>; after: <pass totals>.
Gates on staged tree <git write-tree hash>:
- bun run test:sandbox: unit <n> pass / <n> fail / <n> skip, tcp <n> / <n>,
  embedded <n> / <n>, anomalies <none | list>, artifacts/test-sandbox/<timestamp>/
- bun run test:model: <totals | not triggered because ...>
- bun run test:sandbox:sdk: <totals | not triggered: no sdk/ change>
- bun run typecheck, bun run format:check, git diff --check: <results>
Known limits: <checks not run and why>.

Verdict: PASS, CONDITIONAL or FAIL, with numbered concerns by severity.
```

After a `FAIL`, send the same brief with a "Fixed since the last round:" list naming
each concern and the test or change that answers it.
