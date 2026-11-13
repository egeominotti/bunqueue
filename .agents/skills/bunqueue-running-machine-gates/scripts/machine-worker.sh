#!/usr/bin/env bash
# One Machine of the OrbStack Machine gate (../SKILL.md), from `orb create` to a finished
# run of machine-steps.sh inside it. machine-gate.sh starts one worker per distro; run
# machine-gate.sh, not this script. Copying the logs back and deleting the Machine is
# machine-cleanup.sh's job, on every exit path. Compatible with macOS bash 3.2.
set -euo pipefail

# The two environment variables exist only so that tests can shorten the waits.
readonly POLL_SECONDS=${BUNQUEUE_MACHINE_POLL_SECONDS:-30}
readonly BOUND_SECONDS=${BUNQUEUE_MACHINE_BOUND_SECONDS:-900}
readonly TIMEOUT_SECONDS=10800
readonly UNREACHABLE_SECONDS=600

usage() {
  cat <<'EOF'
Usage: machine-worker.sh --distro D --name N --arch A --run-dir DIR --state-dir DIR
                         --snapshot DIR --content-hash H --bun-version X.Y.Z
                         --steps LIST [--dry-run]

Creates the isolated Machine N (`orb create --isolated --isolate-network`, never a
mount or a forwarded agent) after refusing a name that already exists, records it in
STATE-DIR/created before the create starts, checks `orb info` for isolation, waits
for SSH (120 s), proves the isolation inside, installs packages and the pinned Bun,
copies the snapshot and the gate scripts with rsync over SSH (agent and port
forwarding off), compares content hashes (the Machine's goes to
RUN-DIR/N/content-hash.txt), starts machine-steps.sh detached and polls it: every
30 s, at most 180 min, and at most 10 min unreachable, printing every step that
started or finished, with its exit code, on stderr. `orb create`, the package
install, the Bun download and each rsync are stopped after 15 min each. Every logged
command ends its log with a terminal line, because orb and rsync print nothing off a
terminal: `(exit N)`, `(stopped after Ns)` at the bound, or `(interrupted by SIGTERM)`
(or SIGINT) when the worker is stopped while it runs, as machine-cleanup.sh does; the
worker then stops that command supervisor first (SIGTERM, bounded SIGKILL escalation), so nothing writes
after that line. On
an infrastructure problem it writes the reason to RUN-DIR/N/INFRA and exits 4.

Options:
  --dry-run    Print every command; create, copy and write nothing
  -h, --help   Show this help

Exit codes: 0 machine-steps.sh finished (its results are in the Machine), 2 usage
error, 4 infrastructure failure (RUN-DIR/N/INFRA says why), 143 or 130 stopped by
SIGTERM or SIGINT.
EOF
}

say() { printf '%s\n' "$*" >&2; }
usage_error() {
  say "machine-worker.sh: $*"
  say 'Run with --help for usage.'
  exit 2
}
need_value() { [ "$2" -ge 2 ] || usage_error "$1 needs a value"; }

distro='' name='' arch='' run_dir='' state_dir='' snapshot='' content_hash='' bun_version='' steps=''
dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    --distro) need_value "$1" $# && distro=$2 && shift 2 ;;
    --name) need_value "$1" $# && name=$2 && shift 2 ;;
    --arch) need_value "$1" $# && arch=$2 && shift 2 ;;
    --run-dir) need_value "$1" $# && run_dir=$2 && shift 2 ;;
    --state-dir) need_value "$1" $# && state_dir=$2 && shift 2 ;;
    --snapshot) need_value "$1" $# && snapshot=$2 && shift 2 ;;
    --content-hash) need_value "$1" $# && content_hash=$2 && shift 2 ;;
    --bun-version) need_value "$1" $# && bun_version=$2 && shift 2 ;;
    --steps) need_value "$1" $# && steps=$2 && shift 2 ;;
    --dry-run) dry_run=1 && shift ;;
    -h | --help) usage && exit 0 ;;
    *) usage_error "unknown option '$1'" ;;
  esac
done
for pair in "distro:$distro" "name:$name" "arch:$arch" "run-dir:$run_dir" "state-dir:$state_dir" \
  "snapshot:$snapshot" "content-hash:$content_hash" "bun-version:$bun_version" "steps:$steps"; do
  [ -n "${pair#*:}" ] || usage_error "--${pair%%:*} is required"
done
printf '%s' "$name" | grep -Eq '^bunqueue-[a-z]+-[A-Za-z0-9-]+$' || usage_error "bad --name '$name'"
printf '%s' "$bun_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || usage_error "bad --bun-version '$bun_version'"
printf '%s' "$steps" | grep -Eq '^[a-z,]+$' || usage_error "bad --steps '$steps'"
case "$arch" in arm64 | amd64) ;; *) usage_error "bad --arch '$arch'" ;; esac

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/machine-process.sh"
source "$script_dir/machine-claims.sh"
mdir="$run_dir/$name"
host_log=/dev/null
ssh_opts='-o BatchMode=yes -o ForwardAgent=no -o ClearAllForwardings=yes -o ForwardX11=no -o ConnectTimeout=20'

# show CMD...: print a command the way a shell would read it back.
show() {
  local word
  printf '+'
  for word in "$@"; do
    case "$word" in
      '' | *[!A-Za-z0-9_./:=@,+%-]*) printf " '%s'" "$(printf '%s' "$word" | sed "s/'/'\\\\''/g")" ;;
      *) printf ' %s' "$word" ;;
    esac
  done
  printf '\n'
}
# The command run() is waiting for, its log and its watchdog: a signal that stops the
# worker there stops that command too and ends its log with a terminal line.
current_log=''
# on_signal NAME CODE: stop the current command (SIGTERM, SIGKILL after 5 s: a
# background child of bash ignores SIGINT, and a command may ignore SIGTERM), then its
# watchdog, end its log and exit CODE. It polls rather than starting a helper: a
# subshell forked here would inherit the ignored SIGTERM and could not be stopped.
on_signal() {
  local pid
  trap '' INT TERM
  # Enumerate owned roots to cover a signal before bounded assigns current_pid.
  # The Bun supervisor, rather than two tree controllers, stops its command group.
  for pid in $(children "$$"); do
    [ "$(parent_of "$pid")" = "$$" ] || continue
    stop_owned "$pid"
    wait "$pid" 2>/dev/null || true
  done
  [ -z "$current_log" ] || echo "(interrupted by $1)" >>"$current_log" || true
  exit "$2"
}
# run OUT CMD...: dry run prints CMD; otherwise logs it, appends its output and its
# exit code to OUT, and stops it after BOUND_SECONDS (status 124).
run() {
  local out=$1 bounded_log=$1 rc=0
  shift
  if [ "$dry_run" -eq 1 ]; then show "$@" && return 0; fi
  show "$@" >>"$host_log"
  current_log=$out
  bounded "$BOUND_SECONDS" "$@" 2>>"$host_log" || rc=$?
  # The terminal line is written before current_log is cleared: a signal in between
  # adds a second terminal line rather than leaving the log without one.
  if [ "$rc" = 124 ]; then
    echo "(stopped after ${BOUND_SECONDS}s)" >>"$out"
    current_log='' && return 124
  fi
  echo "(exit $rc)" >>"$out"
  current_log=''
  return "$rc"
}
remote() {
  local out=$1
  shift
  # ssh_opts is a fixed list of words, split on purpose; the command is one string.
  run "$out" ssh $ssh_opts "$name@orb" "$*"
}
infra() {
  say "machine-worker.sh: [$name] $*"
  [ "$dry_run" -eq 1 ] || printf '%s\n' "$*" >"$mdir/INFRA"
  exit 4
}

if [ "$dry_run" -eq 1 ]; then printf '\n# %s -> %s\n' "$distro" "$name"; else
  mkdir -p "$mdir"
  host_log="$mdir/host.log"
  # A background worker of the gate ignores SIGINT (bash's rule for `&` without job
  # control), so this INT trap matters only when the worker is run by hand.
  trap 'on_signal SIGTERM 143' TERM
  trap 'on_signal SIGINT 130' INT
fi

# Never touch a Machine this run did not create.
# The list is read completely first: a pipe into `grep -q` ends `orb list` with SIGPIPE,
# which pipefail reports as a failure, and a failed list must never read as "free".
if [ "$dry_run" -eq 1 ]; then show orb list -q; else
  claim_name "$name" || infra "another gate holds the claim for $name; it is left alone (check $claim_root/$name)"
  listed=$(bounded "$CONTROL_SECONDS" orb list -q 2>>"$host_log") || infra 'orb list failed; cannot tell whether the name is free'
  nl='
'
  case "$nl$listed$nl" in
    *"$nl$name$nl"*) infra "a Machine named $name already exists; it is not this run's and is left alone" ;;
  esac
fi
[ "$dry_run" -eq 1 ] || { echo "$name" >>"$state_dir/created" && : >"$state_dir/creating.$name"; }
rc=0
run "$mdir/create.log" orb create --isolated --isolate-network --arch "$arch" --cpus 4 --memory 16G \
  --disk 32G "$distro" "$name" || rc=$?
# A create that was stopped can still finish in the daemon: its marker stays, so that
# cleanup waits for the Machine and deletes it.
[ "$rc" != 124 ] || infra "orb create did not finish within ${BOUND_SECONDS}s"
[ "$rc" = 0 ] || infra "orb create failed (exit $rc, see create.log)"
[ "$dry_run" -eq 1 ] || rm -f "$state_dir/creating.$name"

if [ "$dry_run" -eq 1 ]; then
  show orb info -f json "$name"
  echo '# parse that JSON with bun: isolated, isolate_network, no forwarded agent, no mount'
else
  bounded "$CONTROL_SECONDS" orb info -f json "$name" >"$mdir/orb-info.json" 2>>"$host_log" || infra 'orb info failed or timed out'
  why=$(bun -e '
    const info = JSON.parse(await Bun.file(process.argv[1]).text());
    const config = info?.record?.config;
    const problems = [];
    if (!config) problems.push("no record.config");
    else {
      if (config.isolated !== true) problems.push("not isolated");
      if (config.isolate_network !== true) problems.push("network not isolated");
      if (config.forward_ssh_agent !== false) problems.push("SSH agent forwarding not off");
    }
    const mounted = (node) => node && typeof node === "object" && Object.entries(node).some(([key, value]) =>
      (/mount/i.test(key) && value !== null && !(Array.isArray(value) && !value.length) && value !== false) || mounted(value));
    if (mounted(info)) problems.push("a host mount is configured");
    console.log(problems.join("; "));
  ' "$mdir/orb-info.json" 2>&1) || why="orb-info.json is not valid JSON: $why"
  [ -z "$why" ] || infra "orb info check failed: $why"
  waited=0
  while :; do
    rc=0
    bounded "$CONTROL_SECONDS" ssh $ssh_opts "$name@orb" true >>"$host_log" 2>&1 || rc=$?
    [ "$rc" != 124 ] || infra 'SSH readiness query timed out'
    [ "$rc" != 0 ] || break
    waited=$((waited + 2)) && [ "$waited" -le 120 ] || infra 'SSH did not come up within 120 s'
    sleep 2
  done
fi

remote "$mdir/isolation.txt" 'for p in /Users /mnt/mac /var/run/docker.sock; do' \
  'if [ -e "$p" ]; then echo "present: $p"; exit 1; fi; done;' \
  'if [ -n "${SSH_AUTH_SOCK:-}" ]; then echo "SSH_AUTH_SOCK is set"; exit 1; fi;' \
  'echo "isolated: no /Users, /mnt/mac, docker.sock or SSH agent"' || infra 'isolation check failed (see isolation.txt)'
# Dpkg::Use-Pty=0: without it dpkg draws its "Reading database" progress into the log.
remote "$mdir/apt.log" 'sudo -n apt-get update -qq && sudo -n env DEBIAN_FRONTEND=noninteractive' \
  'apt-get install -y -qq -o Dpkg::Use-Pty=0 --no-install-recommends' \
  'ca-certificates curl jq openssl procps rsync unzip' || infra 'apt-get install failed or timed out (see apt.log)'
remote "$mdir/bun-install.log" "curl -fsSL https://bun.sh/install | bash -s bun-v$bun_version" \
  "&& test \"\$(\$HOME/.bun/bin/bun --version)\" = $bun_version" ||
  infra "Bun $bun_version did not install (see bun-install.log)"
run "$mdir/rsync.log" rsync -a --delete -e "ssh $ssh_opts" "$snapshot/" "$name@orb:bunqueue/" ||
  infra 'snapshot copy failed or timed out (see rsync.log)'
run "$mdir/rsync.log" rsync -a -e "ssh $ssh_opts" "$script_dir/machine-steps.sh" \
  "$name@orb:gate/" || infra 'script copy failed (see rsync.log)'
if [ "$dry_run" -eq 1 ]; then show ssh $ssh_opts "$name@orb" 'bash gate/machine-steps.sh --content-hash bunqueue'; else
  hash=$(bounded "$CONTROL_SECONDS" ssh $ssh_opts "$name@orb" 'bash gate/machine-steps.sh --content-hash bunqueue' 2>>"$host_log") ||
    infra 'remote content hash failed'
  printf '%s\n' "$hash" >"$mdir/content-hash.txt"
  [ "$hash" = "$content_hash" ] || infra "content hash differs: host $content_hash, Machine $hash"
fi
remote "$host_log" "nohup bash gate/machine-steps.sh --repo bunqueue --out gate-out --steps $steps" \
  "--bun-version $bun_version >gate-runner.log 2>&1 </dev/null &" \
  'echo $! >gate-runner.pid' || infra 'could not start machine-steps.sh'

if [ "$dry_run" -eq 1 ]; then
  echo "# poll every ${POLL_SECONDS}s until gate-out/DONE: at most $((TIMEOUT_SECONDS / 60)) min," \
    "at most $((UNREACHABLE_SECONDS / 60)) min unreachable"
  exit 0
fi
waited=0 unreachable=0 seen=0
# Prints every progress line not printed yet: each step's start, and its end with the
# exit code.
show_progress() {
  local new rc=0
  new=$(bounded "$CONTROL_SECONDS" ssh $ssh_opts "$name@orb" "tail -n +$((seen + 1)) gate-out/progress.log 2>/dev/null" 2>/dev/null) || rc=$?
  [ "$rc" != 124 ] || infra 'progress query timed out'
  [ -n "$new" ] || return 0
  printf '%s\n' "$new" | sed "s/^/[$name] /" >&2
  seen=$((seen + $(printf '%s\n' "$new" | wc -l)))
}
while :; do
  # A pid file, not pgrep -f: the polling shell's own command line names the script.
  rc=0
  state=$(bounded "$CONTROL_SECONDS" ssh $ssh_opts "$name@orb" 'if [ -e gate-out/DONE ]; then echo done;' \
    'elif kill -0 "$(cat gate-runner.pid 2>/dev/null)" 2>/dev/null; then echo running; else echo dead; fi' \
    2>>"$host_log") || rc=$?
  [ "$rc" != 124 ] || infra 'state query timed out'
  [ "$rc" = 0 ] || state=unreachable
  show_progress
  case "$state" in
    done) exit 0 ;;
    dead) infra 'machine-steps.sh exited without DONE (see gate-runner.log)' ;;
    running) unreachable=0 ;;
    *) unreachable=$((unreachable + POLL_SECONDS)) ;;
  esac
  [ "$unreachable" -lt "$UNREACHABLE_SECONDS" ] || infra "Machine unreachable over SSH for $((UNREACHABLE_SECONDS / 60)) min"
  [ "$waited" -lt "$TIMEOUT_SECONDS" ] || infra "no result after $((TIMEOUT_SECONDS / 60)) min"
  sleep "$POLL_SECONDS" && waited=$((waited + POLL_SECONDS))
done
