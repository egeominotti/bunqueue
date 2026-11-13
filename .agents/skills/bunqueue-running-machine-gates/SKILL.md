---
name: bunqueue-running-machine-gates
description: "Runs the bunqueue OrbStack Machine gate with scripts/machine-gate.sh. Use when a candidate or release needs its Linux validation on Ubuntu 24.04 or Debian 13 Machines, when asked to validate on OrbStack, orb create or a clean Linux host rather than Docker, when machine-gate.sh exits non-zero or reports the known node gap, when copying a snapshot of the tree into an isolated Machine, or when reading or rerunning a manifest under artifacts/machines. Not a replacement for bun run test:sandbox, and not for Docker sandbox failures (bunqueue-running-gates)."
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

   It prints every step that starts or finishes, with its exit code, on stderr (one
   poll every 30 s) and, at the end, the exit code and
   `artifacts/machines/<run-id>/manifest.md`. `orb create`, the package install, the
   Bun download and each copy are stopped after 15 minutes each (exit 4).
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
created, and deletes them: `orb delete -f` is repeated, up to five times, until
`orb list` no longer shows the name, because the CLI can fail (it has panicked) after
the daemon deleted the Machine, and can be stopped before it did. `run.env` records
`cleanup=`, a `cleanup_note=` that says which Machines' logs were copied and which were
not, and `delete_exit=` with every attempt's exit code; `cleanup.log` and `delete.log`
stay in the run directory. If an interrupted create has still not appeared
after that wait, it may appear later: the run is recorded as `not-deleted` with the
names, exits 4, and you check `orb list` and delete them by hand. A Machine whose name
already exists is never created, touched or deleted, and a failing `orb list` is an
infrastructure failure, never "the name is free". Cleanup ignores further signals, and
runs every `rsync` and `orb` call in a session of its own: a repeated Ctrl-C signals
the terminal's whole process group, and on real OrbStack it killed the copy and the
delete although the cleanup shell ignored it. It is bounded (about 60 s plus, per
Machine, two 120 s copies and five 120 s deletes).
`test/agent-skills-machine-lifecycle.test.ts` proves all of this with a fake OrbStack.

So an interrupt during `orb create` does not return at once: the gate waits the settle
window, then exits 130 only when every Machine the run started creating is confirmed
deleted. In every other case the exit is 4, with the names to check.

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

What stands behind the scripts, as of 2026-11-13 (OrbStack 2.2.5, macOS 27.2.1, arm64,
on `3e08f75b`, before the changes of that day's review):

| Proven on real OrbStack | Proven with fakes only |
| --- | --- |
| The canonical run: exit 3 in 24 min 41 s; in both Machines unit 11871 pass / 6 fail / 399 skip, tcp 69/69 suites and 553/553, embedded 43/43 and 349/349, tinyfs 9 / 0 | A create that appears after the settle window (exit 4, not deleted) |
| SIGTERM and SIGINT during `orb create`, during provisioning and during the steps: exit 130, no Machine and no process left | A failing or slow `orb list` |
| A step subset and `--keep`: exit 5; an existing Machine name: exit 4, the Machine untouched | The rule that only children of the gate are signalled |
| The gap: six node-dependent tests fail, 22 / 0 with the shim | Exit 0 and exit 1 (no real log ended that way), and the other infrastructure failures |
| | The 15-minute bounds, the repeated delete and the detached cleanup: written after the real run, which showed the need; not yet rerun on OrbStack |
| | An `amd64` host |

## Gotchas

- After an interrupt, let the gate finish (up to the 60 s settle window plus the log
  copies). A second, harder kill (`kill -9`) skips the cleanup and can leave a Machine
  that the daemon creates later; read the exit code, and after a 4 run `orb list`.
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
- The Machines and containers share OrbStack's kernel: strong process and filesystem
  isolation, not a separate-kernel boundary.
- `--isolate-network` is not a network sandbox. Measured on OrbStack 2.2.5: a Machine
  created with it cannot reach `host.orb.internal` or the gateway, but it reached a
  listener in the sibling Machine and the Mac's LAN address, and it has the internet
  (the gate installs packages and Bun through it). Only the Docker sandbox runs tests
  without a network; never treat a Machine as offline.
- `create.log`, `rsync.log` and `delete.log` hold little more than `(exit N)` lines:
  `orb` and `rsync` print nothing when they are not on a terminal. The exit codes are
  the record.
