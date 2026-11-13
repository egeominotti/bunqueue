#!/usr/bin/env bash
# The bunqueue OrbStack Machine gate (../SKILL.md). Run it with --dry-run first; read it
# only when its output and manifest do not explain a failure. macOS ships bash 3.2, so
# this script and its helpers avoid bash 4 features.
set -euo pipefail

readonly CANONICAL_DISTROS='ubuntu:24.04,debian:13'
readonly ALL_STEPS='unit,tcp,embedded,typecheck,format,tinyfs'

usage() {
  cat <<'EOF'
Usage: machine-gate.sh [options]
       machine-gate.sh --classify <run-dir>

Runs the bunqueue OrbStack Machine gate from a macOS host: one fresh Machine per distro
(--isolated --isolate-network, native architecture, 4 CPUs, 16G memory, 32G disk, no
mount, no forwarded agent), a `git archive` snapshot of one tree copied over OrbStack's
SSH endpoint with agent and port forwarding off, the Bun version pinned in the
snapshot's .github/workflows/ci.yml, then install, build-client and the gate steps.
Helpers: machine-worker.sh (one Machine), machine-steps.sh (inside it),
machine-cleanup.sh (stop, copy back, delete), machine-verdict.sh (the manifest).

Every Machine the run created is deleted when it ends: after success, after a failure,
and after SIGTERM or SIGINT, once its logs are copied back to artifacts/machines/<run-id>/.
A Machine whose name already exists is never created, touched or deleted. A full run
takes about 30 minutes; run it in the background. Started with `&` from a
non-interactive shell it ignores SIGINT (the shell's rule), so stop it with SIGTERM.

Options:
  --tree <tree-ish>    Tree to gate (default: the index, as `git write-tree` prints it)
  --distros <list>     Comma-separated distro:version (default: ubuntu:24.04,debian:13);
                       ubuntu:24.04 alone is the gate outside a release
  --steps <list>       Subset of unit,tcp,embedded,typecheck,format,tinyfs (default: all)
  --run-id <id>        Run id and Machine name suffix, [A-Za-z0-9-] (default: UTC time)
  --allow-file <path>  A reviewed tracked file the secret scan may pass (repeatable;
                       .env.example is always allowed)
  --keep               Keep the Machines for debugging; the verdict is then diagnostic
  --dry-run            Print every command; create, copy, write and delete nothing
  --classify <dir>     Print the manifest of a run directory and exit with its verdict
                       (machine-verdict.sh); starts no Machine
  -h, --help           Show this help

Exit codes:
  0    evidence: every step passed in every Machine. Release evidence only with both
       ubuntu:24.04 and debian:13; with ubuntu:24.04 alone, evidence for a candidate
  1    a real failure: a step failed (the unit suite included)
  2    usage error
  3    retired, never returned: it was the known node gap of the Bun-only Machines,
       which the tests now close themselves (a run that exited 3 reclassifies as 1)
  4    precondition or infrastructure failure (no OrbStack, whitespace errors, secret
       scan, an existing Machine name, creation, isolation, SSH, copy, hash mismatch,
       timeout, a Machine not deleted or no recorded cleanup); nothing is claimed
  5    diagnostic: passed but not evidence: a step subset, no Ubuntu 24.04 Machine,
       or --keep
  130  interrupted (SIGINT or SIGTERM) and every Machine deleted; 4 if one was not
EOF
}

say() { printf '%s\n' "$*" >&2; }
die() {
  local code=$1
  shift
  say "machine-gate.sh: $*"
  exit "$code"
}
usage_error() {
  say "machine-gate.sh: $*"
  say 'Run with --help for usage.'
  exit 2
}
need_value() { [ "$2" -ge 2 ] || usage_error "$1 needs a value"; }

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$script_dir/../../../.." && pwd)

tree='' distros=$CANONICAL_DISTROS steps=$ALL_STEPS run_id='' keep=0 dry_run=0
classify_dir='' allowed='.env.example'
while [ $# -gt 0 ]; do
  case "$1" in
    --tree) need_value "$1" $# && tree=$2 && shift 2 ;;
    --distros) need_value "$1" $# && distros=$2 && shift 2 ;;
    --steps) need_value "$1" $# && steps=$2 && shift 2 ;;
    --run-id) need_value "$1" $# && run_id=$2 && shift 2 ;;
    --allow-file) need_value "$1" $# && allowed="$allowed $2" && shift 2 ;;
    --keep) keep=1 && shift ;;
    --dry-run) dry_run=1 && shift ;;
    --classify) need_value "$1" $# && classify_dir=$2 && shift 2 ;;
    -h | --help) usage && exit 0 ;;
    *) usage_error "unknown option '$1'" ;;
  esac
done

for step in $(printf '%s' "$steps" | tr ',' ' '); do
  case ",$ALL_STEPS," in *",$step,"*) ;; *) usage_error "unknown step '$step'" ;; esac
done
[ -n "$(printf '%s' "$steps" | tr -d ', ')" ] || usage_error '--steps is empty'
seen=''
for distro in $(printf '%s' "$distros" | tr ',' ' '); do
  printf '%s' "$distro" | grep -Eq '^[a-z]+:[0-9][0-9.]*$' || usage_error "bad distro '$distro' (distro:version)"
  case " $seen " in *" ${distro%%:*} "*) usage_error "two Machines of one distro: ${distro%%:*}" ;; esac
  seen="$seen ${distro%%:*}"
done
[ -z "$run_id" ] || printf '%s' "$run_id" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9-]{0,39}$' ||
  usage_error "bad --run-id '$run_id'"
[ -z "$tree" ] || printf '%s' "$tree" | grep -Eq '^[A-Za-z0-9._/^~@{}-]+$' || usage_error "bad --tree '$tree'"
for path in $allowed; do
  case "$path" in /* | *..*) usage_error "--allow-file takes a repository-relative path: $path" ;; esac
done
[ -z "$classify_dir" ] || exec bash "$script_dir/machine-verdict.sh" "$classify_dir"

case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=amd64 ;;
  *) die 4 "unsupported host architecture $(uname -m)" ;;
esac
run_id=${run_id:-$(date -u +%Y%m%dT%H%M%SZ)}
run_dir="$repo/artifacts/machines/$run_id"
machine_name() {
  case "${1%%:*}" in ubuntu) echo "bunqueue-ci-$run_id" ;; *) echo "bunqueue-${1%%:*}-$run_id" ;; esac
}
ci_bun_version() {
  sed -nE "s/^[[:space:]]*BUN_VERSION:[[:space:]]*['\"]?([0-9][^'\"[:space:]]*)['\"]?.*/\1/p" "$1" | head -n 1
}
checked_bun_version() {
  local version
  version=$(ci_bun_version "$1")
  printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die 4 "BUN_VERSION in $1 is not X.Y.Z: '$version'"
  echo "$version"
}
# worker DISTRO [--dry-run]: machine-worker.sh for one Machine of this run.
worker() {
  local distro=$1 mode=${2:-}
  set -- bash "$script_dir/machine-worker.sh" $mode --distro "$distro" --name "$(machine_name "$distro")" --arch "$arch" \
    --run-dir "$run_dir" --state-dir "$state_dir" --snapshot "$snapshot" \
    --content-hash "$content_hash" --bun-version "$bun_version" --steps "$steps"
  if [ "$mode" = --dry-run ]; then "$@"; else exec "$@"; fi
}

if [ "$dry_run" -eq 1 ]; then
  echo "machine-gate.sh: dry run; nothing is created, copied, written or deleted"
  echo "run id $run_id; artifacts would go to artifacts/machines/$run_id/"
  bun_version=$(checked_bun_version "$repo/.github/workflows/ci.yml")
  state_dir='<state>' snapshot='<state>/snapshot' content_hash='<hash>'
  [ -n "$tree" ] || echo "+ git -C $repo write-tree"
  echo "+ git -C $repo diff --check HEAD ${tree:-<tree>}"
  echo "+ git -C $repo archive --format=tar ${tree:-<tree>}"
  echo "# extract to $snapshot, secret scan (allowed: $allowed), content hash, Bun $bun_version from its ci.yml"
  for distro in $(printf '%s' "$distros" | tr ',' ' '); do worker "$distro" --dry-run; done
  echo
  extra=''
  [ "$keep" -eq 0 ] || extra=--keep
  bash "$script_dir/machine-cleanup.sh" --dry-run --run-dir "$run_dir" --state-dir "$state_dir" $extra
  echo "# then machine-verdict.sh writes manifest.md; exit 0 pass, 1 fail, 4 infra, 5 diagnostic," \
    "130 interrupted (every Machine deleted; 4 if one was not)"
  exit 0
fi

[ "$(uname -s)" = Darwin ] || die 4 'OrbStack Machines need a macOS host'
for tool in orb ssh rsync git tar bun; do command -v "$tool" >/dev/null 2>&1 || die 4 "$tool is not installed"; done
source "$script_dir/machine-process.sh"
# Preflight queries precede run state and the full cleanup traps. Stop every still
# owned child here, including a query launched just before bounded records its pid.
on_preflight_signal() {
  local pid
  trap '' INT TERM
  for pid in $(children "$$"); do
    [ "$(parent_of "$pid")" = "$$" ] || continue
    stop_owned "$pid"
    wait "$pid" 2>/dev/null || true
  done
  exit 130
}
trap on_preflight_signal INT TERM
bounded "$CONTROL_SECONDS" orb list -q >/dev/null 2>&1 || die 4 'OrbStack does not answer (orb list failed); start it first'
[ ! -e "$run_dir" ] || die 4 "$run_dir already exists; pick another --run-id"
git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || die 4 "$repo is not a Git checkout"
if [ -z "$tree" ]; then tree=$(git -C "$repo" write-tree) || die 4 'git write-tree failed (unmerged index?)'; fi
tree_hash=$(git -C "$repo" rev-parse --verify --quiet "$tree^{tree}") || die 4 "not a tree: $tree"
if git -C "$repo" rev-parse --verify --quiet HEAD >/dev/null; then
  git -C "$repo" diff --check HEAD "$tree_hash" >&2 || die 4 "git diff --check HEAD $tree_hash reports whitespace errors"
fi

mkdir -p "$repo/artifacts/machines"
mkdir "$run_dir" || die 4 "$run_dir already exists; pick another --run-id"
state_dir=$(mktemp -d "${TMPDIR:-/tmp}/bunqueue-machine-gate.XXXXXX")
pids='' finished=0 interrupted=0
finish() {
  local rc=$1 cleanup_rc=0 extra=''
  [ "$finished" = 0 ] || return 0
  finished=1
  trap '' INT TERM
  [ "$keep" -eq 0 ] || extra=--keep
  if [ -d "$run_dir" ]; then
    bash "$script_dir/machine-cleanup.sh" --run-dir "$run_dir" --state-dir "$state_dir" --pids "$pids" \
      --parent $$ $extra || cleanup_rc=$?
    for pid in $pids; do wait "$pid" 2>/dev/null || true; done
    [ "$interrupted" = 0 ] || echo 'interrupted=yes' >>"$run_dir/run.env"
    echo "finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$run_dir/run.env"
    printf 'machine\tstep\texit\tseconds\tstart_utc\tend_utc\tcommand\n' >"$run_dir/steps.tsv"
    for name in $(sed -n 's/^machines=//p' "$run_dir/run.env" | tr ',' ' '); do
      [ ! -f "$run_dir/$name/steps.tsv" ] ||
        awk -v m="$name" 'NR > 1 { print m "\t" $0 }' "$run_dir/$name/steps.tsv" >>"$run_dir/steps.tsv"
    done
    rc=0
    bash "$script_dir/machine-verdict.sh" "$run_dir" >"$run_dir/manifest.md" || rc=$?
    [ "$cleanup_rc" = 0 ] || [ "$rc" = 1 ] || rc=4
    [ "$interrupted" = 0 ] || [ "$rc" = 4 ] || rc=130
    echo "machine-gate.sh: exit $rc; manifest artifacts/machines/$run_id/manifest.md"
  fi
  rm -rf "$state_dir"
  return "$rc"
}
on_exit() {
  local rc=$?
  trap - EXIT
  finish "$rc" || rc=$?
  exit "$rc"
}
trap on_exit EXIT
trap 'interrupted=1; say "machine-gate.sh: interrupted; stopping the workers and deleting the Machines"; exit 130' INT TERM

snapshot="$state_dir/snapshot"
mkdir "$snapshot"
git -C "$repo" archive --format=tar "$tree_hash" >"$state_dir/snapshot.tar" || die 4 'git archive failed'
tar -x -C "$snapshot" -f "$state_dir/snapshot.tar"
hits=$(cd "$snapshot" && find . \( -path ./node_modules -o -path ./artifacts -o -name .git \) -prune -print -o -type f \( \
  -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' -o \
  -name 'id_rsa*' -o -name 'id_ed25519*' -o -name 'id_ecdsa*' -o -name '.npmrc' -o -name '.netrc' -o \
  -name '.pypirc' -o -name '*.db' -o -name '*.db-wal' -o -name '*.db-shm' -o -name '*.sqlite' -o \
  -name '*.sqlite3' \) -print | sed 's#^\./##' | LC_ALL=C sort)
for path in $hits; do
  case " $allowed " in *" $path "*) ;; *) die 4 "not copying a tree that contains $path (review it, then --allow-file $path)" ;; esac
done
bun_version=$(checked_bun_version "$snapshot/.github/workflows/ci.yml")
content_hash=$(bash "$script_dir/machine-steps.sh" --content-hash "$snapshot")
outside=$(git -C "$repo" status --porcelain --untracked-files=all | grep -c -E '^(.[MD]|\?\?)' || true)

machines=''
for distro in $(printf '%s' "$distros" | tr ',' ' '); do machines="$machines${machines:+,}$(machine_name "$distro")"; done
orb_version=$(bounded "$CONTROL_SECONDS" orb version 2>/dev/null) || die 4 'OrbStack version query failed or timed out'
{
  echo "run_id=$run_id"
  echo "tree=$tree_hash"
  echo "archive_sha256=$(bash -c 'command -v sha256sum >/dev/null && sha256sum "$1" || shasum -a 256 "$1"' _ "$state_dir/snapshot.tar" | cut -d ' ' -f 1)"
  echo "content_hash=$content_hash"
  echo "files=$(cd "$snapshot" && find . -type f | wc -l | tr -d ' ')"
  echo "distros=$distros"
  echo "steps=$steps"
  echo "machines=$machines"
  echo "arch=$arch"
  echo "bun=$bun_version"
  echo "host=$(sw_vers -productName 2>/dev/null || true) $(sw_vers -productVersion 2>/dev/null || true) $(uname -m)"
  echo "orb=$(printf '%s\n' "$orb_version" | head -n 1 | sed 's/^Version: //')"
  echo "head=$(git -C "$repo" rev-parse --short HEAD 2>/dev/null || echo none)"
  echo "outside=$outside unstaged or untracked working-tree paths (the snapshot is the tree only)"
  echo "started=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$run_dir/run.env"
say "machine-gate.sh: run $run_id, tree $tree_hash, Bun $bun_version, Machines $machines"
[ "$outside" = 0 ] || say "machine-gate.sh: $outside working-tree paths are not in the snapshot (stage them or pass --tree)"

for distro in $(printf '%s' "$distros" | tr ',' ' '); do
  worker "$distro" &
  pids="$pids $!"
done
# A reaped pid leaves the list: the kernel may reuse it for an unrelated process, and
# cleanup signals what it is given. (A signal ends `wait` through the trap instead.)
for pid in $pids; do
  wait "$pid" || true
  rest=''
  for other in $pids; do [ "$other" = "$pid" ] || rest="$rest $other"; done
  pids=$rest
done
exit 0
