#!/usr/bin/env bash
# Runs the gate steps inside one disposable OrbStack Machine. machine-gate.sh copies
# it into the Machine and starts it; run machine-gate.sh, not this script. Keep it
# compatible with bash 3.2: machine-gate.sh also runs --content-hash on macOS.
set -euo pipefail

readonly ALL_STEPS='unit,tcp,embedded,typecheck,format,tinyfs'
readonly STEP_TIMEOUT_SECONDS=3600

usage() {
  cat <<'EOF'
Usage: machine-steps.sh [--repo DIR] [--out DIR] [--steps LIST] [--bun-version VER]
                        [--dry-run]
       machine-steps.sh --content-hash DIR

Inside a disposable OrbStack Machine: records the environment in OUT/environment.txt,
then runs install, build-client and the selected steps in DIR, writing one
OUT/<step>.log and one OUT/steps.tsv row per step, and touches OUT/DONE at the end.
A step that cannot start because install or build-client failed gets exit 125. No
node->bun shim is installed: the Machine stays Bun-only.

--content-hash prints one SHA-256 over the content of every file and the target of
every symlink below DIR; macOS and Linux print the same value for the same tree.

Options:
  --repo DIR         Snapshot to test (default: $HOME/bunqueue)
  --out DIR          Output directory, must not exist (default: $HOME/gate-out)
  --steps LIST       Subset of unit,tcp,embedded,typecheck,format,tinyfs (default: all)
  --bun-version VER  Fail unless bun --version prints VER
  --dry-run          Print the steps; run and write nothing
  -h, --help         Show this help

Exit codes: 0 every step passed, 1 a step failed (see OUT/steps.tsv), 2 usage error,
4 unusable environment (no bun, another Bun version, OUT exists).
EOF
}

die() {
  local code=$1
  shift
  printf 'machine-steps.sh: %s\n' "$*" >&2
  exit "$code"
}

usage_error() {
  printf 'machine-steps.sh: %s\nRun with --help for usage.\n' "$*" >&2
  exit 2
}

# One hash over file contents and symlink targets; sorting whole lines keeps it
# independent of traversal order, and `find -exec +` runs nothing for no match.
content_hash() {
  local dir=$1 sha
  if command -v sha256sum >/dev/null 2>&1; then sha='sha256sum'; else sha='shasum -a 256'; fi
  [ -d "$dir" ] || die 4 "--content-hash: no directory $dir"
  (
    cd "$dir"
    {
      find . -type f -exec $sha {} +
      find . -type l -exec sh -c 'for l; do printf "link %s -> %s\n" "$l" "$(readlink "$l")"; done' sh {} +
    } | LC_ALL=C sort | $sha | cut -d ' ' -f 1
  )
}

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo="$HOME/bunqueue"
out="$HOME/gate-out"
steps=$ALL_STEPS
bun_version=''
dry_run=0

need_value() { [ "$2" -ge 2 ] || usage_error "$1 needs a value"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --content-hash)
      need_value "$1" $#
      content_hash "$2"
      exit 0
      ;;
    --repo) need_value "$1" $# && repo=$2 && shift 2 ;;
    --out) need_value "$1" $# && out=$2 && shift 2 ;;
    --steps) need_value "$1" $# && steps=$2 && shift 2 ;;
    --bun-version) need_value "$1" $# && bun_version=$2 && shift 2 ;;
    --dry-run) dry_run=1 && shift ;;
    -h | --help) usage && exit 0 ;;
    *) usage_error "unknown option '$1'" ;;
  esac
done

selected=''
for step in $(printf '%s' "$steps" | tr ',' ' '); do
  case ",$ALL_STEPS," in
    *",$step,"*) ;;
    *) usage_error "unknown step '$step' (choose from $ALL_STEPS)" ;;
  esac
  case " $selected " in
    *" $step "*) usage_error "step '$step' is listed twice" ;;
  esac
  selected="$selected $step"
done
[ -n "$selected" ] || usage_error '--steps is empty'
[ -z "$bun_version" ] || printf '%s' "$bun_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' ||
  usage_error "bad --bun-version '$bun_version' (X.Y.Z)"

command_for() {
  case "$1" in
    install) echo 'bun install --frozen-lockfile --ignore-scripts' ;;
    build-client) echo 'bun run build:client' ;;
    unit) echo 'bun test --parallel=4' ;;
    tcp) echo 'bun scripts/tcp/run-all-tests.ts' ;;
    embedded) echo 'bun scripts/embedded/run-all-tests.ts' ;;
    typecheck) echo 'bun run typecheck' ;;
    format) echo 'bun run format:check' ;;
    tinyfs)
      # A real 16 MiB filesystem for the SQLITE_FULL admission tests, always unmounted.
      echo 'set -e; sudo -n mkdir -p /mnt/bunqueue-tinyfs; sudo -n mount -t tmpfs -o size=16m tmpfs /mnt/bunqueue-tinyfs; sudo -n chown "$(id -u):$(id -g)" /mnt/bunqueue-tinyfs; rc=0; BUNQUEUE_TINYFS=/mnt/bunqueue-tinyfs bun test test/repro-disk-full.test.ts || rc=$?; sudo -n umount /mnt/bunqueue-tinyfs; exit $rc'
      ;;
  esac
}

if [ "$dry_run" -eq 1 ]; then
  echo "machine-steps.sh: dry run in $repo, output $out; nothing runs"
  for step in install build-client $selected; do printf '%-12s %s\n' "$step" "$(command_for "$step")"; done
  exit 0
fi

export PATH="$HOME/.bun/bin:$PATH"
command -v bun >/dev/null 2>&1 || die 4 'bun is not on PATH'
if [ -n "$bun_version" ] && [ "$(bun --version)" != "$bun_version" ]; then
  die 4 "bun $(bun --version) is installed, the gate needs $bun_version"
fi
[ -d "$repo" ] || die 4 "no snapshot at $repo"
[ ! -e "$out" ] || die 4 "$out already exists; use a fresh Machine"
mkdir -p "$out"
printf 'step\texit\tseconds\tstart_utc\tend_utc\tcommand\n' >"$out/steps.tsv"

record_environment() {
  {
    printf 'os: %s\n' "$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-unknown}")"
    printf 'arch: %s\n' "$(uname -m)"
    printf 'kernel: %s\n' "$(uname -srv)"
    for key in cpu.max memory.max memory.swap.max pids.max cpuset.cpus.effective; do
      printf 'cgroup.%s: %s\n' "$key" "$(cat "/sys/fs/cgroup/$key" 2>/dev/null || echo unavailable)"
    done
    printf 'nproc: %s\n' "$(nproc 2>/dev/null || echo unknown)"
    printf 'tz: TZ=%s, localtime %s\n' "${TZ:-unset}" "$(readlink -f /etc/localtime 2>/dev/null || echo unknown)"
    printf 'bun: %s (%s)\n' "$(bun --version)" "$(bun --revision)"
    printf 'node: %s\n' "$(command -v node || echo absent)"
    printf 'packages: %s\n' "$(dpkg-query -W -f='${Package} ${Version}, ' ca-certificates curl jq openssl rsync unzip procps 2>/dev/null || echo unavailable)"
    echo '----'
    echo '## /etc/os-release' && cat /etc/os-release
    echo '## uname -a' && uname -a
    echo '## /proc/self/cgroup' && cat /proc/self/cgroup
    echo '## free -m' && free -m
    echo '## df -h / /tmp' && df -h / /tmp
    echo '## ulimit -n' && ulimit -n
    echo '## locale' && locale 2>/dev/null | head -n 3
    echo '## env (filtered)'
    env | grep -E '^(CI|NODE_ENV|TZ|LANG|LC_ALL|HOME|USER|TMPDIR|BUNQUEUE_[A-Z_]*)=' | sort
  } >"$out/environment.txt" 2>&1 || true
}

progress() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >>"$out/progress.log"; }

row() { printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$@" >>"$out/steps.tsv"; }

# run_step NAME: one log, one steps.tsv row; returns the step's exit code.
run_step() {
  local name=$1 cmd start end s rc=0
  cmd=$(command_for "$name")
  start=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  s=$(date +%s)
  progress "$name started"
  (cd "$repo" && timeout --kill-after=60 "$STEP_TIMEOUT_SECONDS" bash -c "$cmd") \
    >"$out/$name.log" 2>&1 </dev/null || rc=$?
  end=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  row "$name" "$rc" "$(($(date +%s) - s))" "$start" "$end" "$cmd"
  progress "$name exit=$rc"
  return "$rc"
}

record_environment
progress start
failed=0
prepared=1
for step in install build-client; do
  if [ "$prepared" -eq 1 ]; then
    run_step "$step" || { failed=1 && prepared=0; }
  else
    row "$step" 125 0 - - "not run: an earlier preparation step failed"
  fi
done

for step in $selected; do
  if [ "$prepared" -eq 0 ]; then
    row "$step" 125 0 - - "not run: install or build-client failed"
    failed=1
    continue
  fi
  run_step "$step" || failed=1
done

progress done
touch "$out/DONE"
exit "$failed"
