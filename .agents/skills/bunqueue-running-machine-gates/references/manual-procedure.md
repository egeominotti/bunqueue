# The Machine gate by hand

Use this only when `scripts/machine-gate.sh` cannot run (a step needs a change it does
not support) or to understand a manifest. Each step is what the script does, in order.
The commands and their rationale are also in
[docs/testing.md](../../../../docs/testing.md#orbstack-machine-isolation).

## Contents

- [1. Snapshot one tree](#1-snapshot-one-tree)
- [2. Create the Machines](#2-create-the-machines)
- [3. Prepare each Machine](#3-prepare-each-machine)
- [4. Copy the snapshot](#4-copy-the-snapshot)
- [5. Run the steps](#5-run-the-steps)
- [6. No known gap check](#6-no-known-gap-check)
- [7. Copy back, record, delete](#7-copy-back-record-delete)
- [Manifest fields](#manifest-fields)

## 1. Snapshot one tree

```bash
git diff --check && git diff --cached --check
tree=$(git write-tree)                      # the staged tree; never touches the index
git archive --format=tar "$tree" > snapshot.tar
mkdir snapshot && tar -x -C snapshot -f snapshot.tar
```

`git archive` carries tracked content only: no `.git`, `node_modules`, `artifacts`,
SQLite files or ignored files. To include intended untracked files without staging
them in the shared index, build the tree from a temporary index:

```bash
tmp_index=$(mktemp)
GIT_INDEX_FILE=$tmp_index git read-tree HEAD
GIT_INDEX_FILE=$tmp_index git add -A
tree=$(GIT_INDEX_FILE=$tmp_index git write-tree)
rm -f "$tmp_index"
```

Scan the snapshot before it leaves the host, with the patterns `machine-gate.sh` uses:
no `.env` or `.env.*` other than the reviewed placeholder `.env.example`, no `*.pem`,
`*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, `.npmrc`, `.netrc`,
`.pypirc`, `*.db`, `*.db-wal`, `*.db-shm`, `*.sqlite` or `*.sqlite3`, and no
`node_modules`, `artifacts` or `.git`. Record the archive's SHA-256 and a content hash; the script's is
`bash scripts/machine-steps.sh --content-hash snapshot` (from the skill directory),
which prints the same value on macOS and Linux.

## 2. Create the Machines

```bash
run_id=$(date -u +%Y%m%dT%H%M%SZ)
arch=arm64     # on an Intel Mac: amd64; never a translated architecture for evidence
orb create --isolated --isolate-network --arch "$arch" --cpus 4 --memory 16G --disk 32G \
  ubuntu:24.04 "bunqueue-ci-$run_id"
orb create --isolated --isolate-network --arch "$arch" --cpus 4 --memory 16G --disk 32G \
  debian:13 "bunqueue-debian-$run_id"
orb info -f json "bunqueue-ci-$run_id"   # isolated: true, isolate_network: true,
                                         # forward_ssh_agent: false, no mounts
```

Never add `--mount` or `--forward-ssh-agent`. `--isolated` removes the macOS filesystem
and integrations. `--isolate-network` blocks `host.orb.internal` and the gateway only:
the Machine still reaches the internet, the other Machines and the Mac's LAN address
(measured on OrbStack 2.2.5), so it is not an offline environment.

## 3. Prepare each Machine

```bash
ssh_opts='-o BatchMode=yes -o ForwardAgent=no -o ClearAllForwardings=yes'
m="bunqueue-ci-$run_id"
ssh $ssh_opts "$m@orb" 'test ! -e /Users && test ! -e /mnt/mac && test ! -S /var/run/docker.sock && test -z "${SSH_AUTH_SOCK:-}"'
ssh $ssh_opts "$m@orb" 'sudo apt-get update && sudo apt-get install -y --no-install-recommends ca-certificates curl jq openssl procps rsync unzip'
bun_version=$(sed -nE "s/^[[:space:]]*BUN_VERSION:[[:space:]]*['\"]?([0-9][^'\"[:space:]]*)['\"]?.*/\1/p" snapshot/.github/workflows/ci.yml | head -n 1)
ssh $ssh_opts "$m@orb" "curl -fsSL https://bun.sh/install | bash -s bun-v$bun_version"
```

`ca-certificates jq openssl` mirror `Dockerfile.test`; `rsync` is for the copy,
`curl` and `unzip` for the Bun installer, `procps` for the environment record.

## 4. Copy the snapshot

```bash
rsync -a --delete -e "ssh $ssh_opts" snapshot/ "$m@orb:bunqueue/"
```

`orb push` cannot write into an isolated Machine. Compare the content hash inside the
Machine with the host's before running anything.

## 5. Run the steps

Inside each Machine, from `~/bunqueue`, with `~/.bun/bin` first on PATH, one log per
step and its exit code and duration recorded:

```bash
bun install --frozen-lockfile --ignore-scripts
bun run build:client
bun test --parallel=4
bun scripts/tcp/run-all-tests.ts
bun scripts/embedded/run-all-tests.ts
bun run typecheck
bun run format:check
sudo mkdir -p /mnt/bunqueue-tinyfs
sudo mount -t tmpfs -o size=16m tmpfs /mnt/bunqueue-tinyfs
sudo chown "$(id -u):$(id -g)" /mnt/bunqueue-tinyfs
BUNQUEUE_TINYFS=/mnt/bunqueue-tinyfs bun test test/repro-disk-full.test.ts
sudo umount /mnt/bunqueue-tinyfs
```

Run long steps detached (`nohup ... &` with a pid file) and poll, so a dropped SSH
session does not kill a 10-minute suite.

## 6. No known gap check

Until 2026-11-13 a failed unit step was followed by a rerun of the two version-gate
test files with and without a node->bun shim (the known node gap, exit 3). Those files
now link their own `node` to Bun, so there is nothing to rerun: a unit failure is a
real failure. Never install a `node` shim in the Machine for the canonical run.

## 7. Copy back, record, delete

Do this on every exit path, also after a failed step or an interrupted run, and only
for Machines this run created:

```bash
mkdir -p "artifacts/machines/$run_id/$m"
rsync -a -e "ssh $ssh_opts" "$m@orb:gate-out/" "artifacts/machines/$run_id/$m/"
rsync -a -e "ssh $ssh_opts" "$m@orb:gate-runner.log" "artifacts/machines/$run_id/$m/"
orb delete -f "bunqueue-ci-$run_id" "bunqueue-debian-$run_id" >>"artifacts/machines/$run_id/delete.log" 2>&1
orb list -q | grep -- "-$run_id" || echo 'no Machine of this run is left'
```

An `orb create` interrupted on the host can still finish in the OrbStack daemon:
check `orb list` again for a minute before concluding that nothing is left. `orb list`
decides, not the exit code of `orb delete`: the CLI has exited non-zero (a panic) after
the Machine was gone, and a Ctrl-C can stop it before the Machine is. Repeat the delete
until the name is no longer listed, and do not press Ctrl-C again while it runs.

## Manifest fields

| Field | Source | Why it is recorded |
| --- | --- | --- |
| Verdict | the classification of every Machine | the one line the evidence quotes |
| Tree, archive sha256, content hash | host | proves which bytes ran; the Machine's hash must equal the host's |
| Content hash in the Machine | `content-hash.txt`, computed inside the Machine after the copy | the other half of that comparison |
| Machines, `orb delete -f` exit codes | `cleanup=`, `cleanup_note=` and `delete_exit=` in `run.env` | whether `orb list` shows none of them, which logs were copied back, and every delete attempt's exit code |
| Scope | the `--distros` and `--steps` used | a subset is diagnostic, not release evidence |
| Created with | the fixed `orb create` flags | isolation is part of the evidence |
| Not in the snapshot | `git status` on the host | unstaged or untracked work that was not tested |
| OS, arch, kernel | `/etc/os-release`, `uname` | distro and native-architecture evidence |
| cgroup cpu.max, memory.max, swap | `/sys/fs/cgroup` | effective limits after OrbStack's clamping |
| Bun, node | `bun --version --revision`, `command -v node` | the pinned toolchain; `node: absent` is expected, the Machines are Bun-only |
| Time zone | `TZ`, `/etc/localtime` | differs from the sandbox's UTC |
| Steps table | `steps.tsv`, the step logs | exit code, seconds and exact totals per step; an interrupted run shows the steps recorded before it stopped |
