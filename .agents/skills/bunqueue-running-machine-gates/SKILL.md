---
name: bunqueue-running-machine-gates
description: "Runs the bunqueue OrbStack Machine gate with scripts/machine-gate.sh: fresh isolated Machines on the native architecture (Ubuntu 24.04 for every candidate, Debian 13 too for a release), a git-archive snapshot of one exact tree, the CI-pinned Bun, the unit, TCP, embedded, typecheck, format and tinyfs steps, a manifest under artifacts/machines, and deletion of every Machine it created, also after a failure or an interrupt. Reports the known Bun-only node gap apart from real failures. Use when a candidate needs its final Linux validation, when asked to validate on Ubuntu, Debian, OrbStack, orb create or a clean Linux host, or when reading or rerunning a Machine manifest. Not a replacement for bun run test:sandbox, and not for Docker sandbox failures (bunqueue-running-gates)."
license: MIT
metadata:
  short-description: OrbStack Ubuntu and Debian Machine gate for bunqueue
---

# Running the OrbStack Machine gate

The rules are in [CLAUDE.md](../../../CLAUDE.md#mandatory-gates) and
[docs/testing.md](../../../docs/testing.md#orbstack-machine-gate-checklist): repository
tests run in isolated OrbStack Machines by default (a macOS-host run is diagnostic
only); the final Linux gate is a fresh Ubuntu 24.04 Machine on the native architecture,
plus Debian 13 for every release; `--isolated --isolate-network`, never a mount, a
forwarded SSH agent or a secret; CI's Bun and the frozen lockfile; and the Machines
supplement the sandboxes, never replace them. The scripts do all of it on the macOS
host; run the first one rather than typing the steps:

- [scripts/machine-gate.sh](scripts/machine-gate.sh): the entry point (snapshot,
  workers, cleanup, verdict);
- [scripts/machine-worker.sh](scripts/machine-worker.sh): one Machine, from
  `orb create` to a finished run inside it;
- [scripts/machine-steps.sh](scripts/machine-steps.sh): the steps inside a Machine;
- [scripts/machine-cleanup.sh](scripts/machine-cleanup.sh): stops the workers, copies
  the logs back and deletes the Machines, on every exit path;
- [scripts/machine-verdict.sh](scripts/machine-verdict.sh): the manifest and the exit
  code.

## Run it

1. Freeze the candidate: stage it, then `git diff --check` and `git diff --cached --check`
   must be clean (the Machine gets no `.git`, so whitespace is checked on the host).
   Record the tree with `git write-tree`.
2. Preview, which creates nothing:

   ```bash
   bash .agents/skills/bunqueue-running-machine-gates/scripts/machine-gate.sh --dry-run --tree <hash>
   ```

3. Run it in the background (about 30 minutes; the Machines run in parallel). The
   default is Ubuntu 24.04 and Debian 13, the release scope; outside a release
   `--distros ubuntu:24.04` is the gate:

   ```bash
   bash .agents/skills/bunqueue-running-machine-gates/scripts/machine-gate.sh --tree <hash>
   ```

   It prints one progress line per step change on stderr and, at the end, the exit code
   and `artifacts/machines/<run-id>/manifest.md`.
4. Read the manifest, then copy its verdict, totals and path into the evidence.

`--steps` takes a subset for diagnosis; the verdict is then DIAGNOSTIC (exit 5).
`--keep` leaves the Machines running for debugging, also with a DIAGNOSTIC verdict;
delete them yourself with `orb delete -f <name>`.

## Exit codes

| Exit | Verdict | What it means |
| --- | --- | --- |
| 0 | PASS | evidence: every step passed in every Machine. Release evidence only with both Ubuntu 24.04 and Debian 13; with Ubuntu 24.04 alone, evidence for a candidate (the manifest's Scope line says which) |
| 3 | KNOWN ENVIRONMENT GAP | evidence with the same scope rule, the canonical result today: every step passed except exactly the known node-dependent unit tests, which pass with a node->bun shim |
| 5 | DIAGNOSTIC | passed (or only the known gap), but not evidence: a step subset, no Ubuntu 24.04 Machine, or `--keep` |
| 1 | FAIL | a real failure: read the step log the manifest names; classify as in bunqueue-running-gates |
| 4 | INFRASTRUCTURE FAILURE | no evidence (OrbStack, whitespace, secret scan, an existing Machine name, creation, isolation, SSH, copy, hash mismatch, timeout), or a Machine not deleted, an interrupted create that never appeared, or no recorded cleanup: that outranks an interrupt |
| 130 | INTERRUPTED | SIGTERM or SIGINT, and every Machine was deleted: nothing is claimed. If cleanup could not delete everything the exit is 4 |
| 2 | usage error | fix the options |

`--classify <run-dir>` (the same as `machine-verdict.sh <run-dir>`) re-reads a run
directory, prints its manifest and exits with the code the run ended with, without
starting a Machine.

## Interrupts and cleanup

`machine-cleanup.sh` runs on every exit path: success, failure, `die`, SIGTERM and
SIGINT. It freezes each live worker's process tree before signalling it (so no
`orb create` or `ssh` survives), and signals only children of the gate: a worker that
already exited is dropped from the list, because its pid may belong to another process
by then. It waits up to 60 s for a create the OrbStack daemon may still finish after its
CLI is gone, copies back `gate-out/` and `gate-runner.log` from every Machine the run
created, deletes them, and records `cleanup=` in `run.env`; `cleanup.log` and
`delete.log` stay in the run directory. If an interrupted create has still not appeared
after that wait, it may appear later: the run is recorded as `not-deleted` with the
names, exits 4, and you check `orb list` and delete them by hand. A Machine whose name
already exists is never created, touched or deleted, and a failing `orb list` is an
infrastructure failure, never "the name is free". Cleanup ignores further signals and
is bounded (about 60 s plus two 120 s copies per Machine).
`test/agent-skills-machine-lifecycle.test.ts` proves all of this with a fake OrbStack.

## The known environment gap

The Machines carry Bun and no Node. `test/repro-docker-version-gate-errors.test.ts`
(2 tests) and `test/repro-release-source-commit.test.ts` (4 tests) run CI's
version-gate bash, whose first line is `node -p "require('./package.json').version"`,
so they fail with `node: command not found` there; the sandbox image (a node->bun
fallback) and GitHub's runners (real Node) pass them. The canonical run installs no
shim. When the unit suite fails, `machine-steps.sh` reruns exactly those two files as
they are and again with a node->bun shim appended to PATH, the way `oven/bun` does,
and the verdict is 3 only when:

- the unit failures are exactly the file and title pairs in
  [assets/known-node-gap.txt](assets/known-node-gap.txt), with
  `node: command not found` and no unhandled error;
- the as-is rerun fails on the same pairs and the shim rerun passes;
- every other step passed.

Any other combination is a real failure (exit 1). If a run ever exits 0, the gap is
gone; update the asset list and this section in the same change.

## Evidence

```text
OrbStack Machines (machine-gate.sh exit 3, artifacts/machines/<run-id>/manifest.md) on
staged tree <hash>: Ubuntu 24.04 and Debian 13, arm64, Bun <version>: unit
<n> pass / 6 fail (the known node gap; 22 / 0 with the shim) / <n> skip, tcp <n>/<n>,
embedded <n>/<n>, typecheck and format clean, tinyfs <n> / 0; Machines deleted.
```

Doing it by hand, and what each manifest field means:
[references/manual-procedure.md](references/manual-procedure.md).

## Gotchas

- Started with `&` from a non-interactive shell (an agent's background command), the
  gate ignores SIGINT: that is the shell's rule for background jobs. Stop it with
  SIGTERM (`kill <pid>`), which runs the same cleanup.
- The snapshot is `git archive <tree>`: untracked files are not in it, even intended
  ones. Stage them, or build a tree from a temporary index (manual procedure, step 1).
- `orb push` cannot write an isolated Machine; the copy is `rsync` over OrbStack's SSH
  endpoint (`MACHINE@orb`), so `rsync` is installed in the Machine first. The SSH key
  stays on macOS, with `ForwardAgent=no` and `ClearAllForwardings=yes`.
- Debian 13 has no `curl` by default and the Bun installer needs `unzip`; the worker
  installs `ca-certificates curl jq openssl procps rsync unzip`.
- The unit suite needs `bun run build:client` first, as in CI and `Dockerfile.test`;
  `machine-steps.sh` runs it as its own step.
- The Machines keep the macOS host's local time zone with `TZ` unset, unlike the
  sandbox (`TZ=UTC`). The manifest records it; a date-dependent failure that only a
  Machine shows is an environment finding to investigate, not noise.
- Requested resources are not effective resources: OrbStack clamps a Machine to its
  global limits, so the manifest records the cgroup `cpu.max` and `memory.max`.
- A translated `amd64` Machine on Apple Silicon is diagnostic only; the gate always
  creates Machines of the host's native architecture.
- Running the Machines while a sandbox runs on the same host shares the OrbStack VM's
  CPUs. Results stay valid, but compare durations only between quiet runs.
- The Machines and containers share OrbStack's kernel: strong process, filesystem and
  network isolation, not a separate-kernel boundary.
