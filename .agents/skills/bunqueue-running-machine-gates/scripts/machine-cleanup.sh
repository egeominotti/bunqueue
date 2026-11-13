#!/usr/bin/env bash
# Ends an OrbStack Machine gate run (../SKILL.md): stops its workers, copies every
# Machine's logs back and deletes every Machine the run created. machine-gate.sh runs
# it on every exit path; run machine-gate.sh, not this script. macOS bash 3.2 compatible.
set -euo pipefail

# The settle window is an environment variable only so that tests can shorten it.
readonly SETTLE_SECONDS=${BUNQUEUE_MACHINE_SETTLE_SECONDS:-60}
readonly COPY_SECONDS=120
readonly DELETE_SECONDS=120
readonly DELETE_TRIES=5
readonly LIST_SECONDS=${BUNQUEUE_MACHINE_CONTROL_SECONDS:-${BUNQUEUE_MACHINE_BOUND_SECONDS:-30}}

usage() {
  cat <<'EOF'
Usage: machine-cleanup.sh --run-dir DIR --state-dir DIR [--pids "PID ..."]
                          [--parent PID] [--keep] [--dry-run]

1. Signals each worker in --pids so its command supervisor owns group cleanup.
   A control query can defer the worker trap for its 30 s bound; after that bound
   plus 5 s, an unresponsive worker tree is frozen top-down with SIGSTOP, then
   gets SIGTERM and SIGKILL after 5 s. A pid whose parent is not --parent (default:
   the caller) is skipped. RUN-DIR/cleanup.log records both lists.
2. Waits up to 60 s for Machines whose `orb create` was interrupted
   (STATE-DIR/creating.<name>): the OrbStack daemon can finish a create after its CLI
   is gone. One that has still not appeared may appear later, so the run is then
   recorded as not-deleted, with its name.
3. Copies gate-out/ and gate-runner.log back from every Machine named in
   STATE-DIR/created that exists, each copy bounded to 120 s.
4. Deletes those Machines with `orb delete -f` (not with --keep), each attempt bounded
   to 120 s and repeated, up to 5 times, until `orb list` no longer shows the name;
   RUN-DIR/delete.log keeps the output and the exit code of every attempt. Only names
   in STATE-DIR/created are deleted: a worker records a name only after checking that
   no Machine has it.
5. Appends `cleanup=deleted|kept|not-deleted|none`, `cleanup_note=` (which logs were
   copied and which were not) and `delete_exit=` to RUN-DIR/run.env.

SIGINT and SIGTERM are ignored while it runs, and every rsync and orb call runs in a
session of its own (setsid, or perl's POSIX::setsid on macOS): a repeated Ctrl-C
signals the terminal's whole process group, and rsync and the orb CLI install their
own handlers, so ignoring the signal in this shell alone did not protect them. It is
bounded to about 60 s plus, per Machine, 2 x 120 s of copies and 5 x 120 s of deletes.

Options:
  --dry-run   Print every command; stop, copy, write and delete nothing
  -h, --help  Show this help

Exit codes: 0 every created Machine deleted (or kept with --keep, or none created),
2 usage error, 4 a Machine is still present, an interrupted create never appeared,
or `orb list` cannot tell.
EOF
}

say() { printf '%s\n' "$*" >&2; }
usage_error() {
  say "machine-cleanup.sh: $*"
  say 'Run with --help for usage.'
  exit 2
}
need_value() { [ "$2" -ge 2 ] || usage_error "$1 needs a value"; }

run_dir='' state_dir='' pids='' parent=$PPID keep=0 dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    --run-dir) need_value "$1" $# && run_dir=$2 && shift 2 ;;
    --state-dir) need_value "$1" $# && state_dir=$2 && shift 2 ;;
    --pids) need_value "$1" $# && pids=$2 && shift 2 ;;
    --parent) need_value "$1" $# && parent=$2 && shift 2 ;;
    --keep) keep=1 && shift ;;
    --dry-run) dry_run=1 && shift ;;
    -h | --help) usage && exit 0 ;;
    *) usage_error "unknown option '$1'" ;;
  esac
done
[ -n "$run_dir" ] && [ -n "$state_dir" ] || usage_error '--run-dir and --state-dir are required'
for pid in $pids $parent; do
  case "$pid" in *[!0-9]*) usage_error "bad pid '$pid'" ;; esac
done
ssh_opts='-o BatchMode=yes -o ForwardAgent=no -o ClearAllForwardings=yes -o ForwardX11=no -o ConnectTimeout=20'

if [ "$dry_run" -eq 1 ]; then
  # A dry run has no worker pids (machine-gate.sh starts no worker): name them instead.
  echo "# stop the workers (${pids:-one per Machine, started by machine-gate.sh}) cooperatively; unresponsive trees:" \
    "SIGSTOP, SIGTERM, SIGKILL after 5 s"
  echo "# wait up to ${SETTLE_SECONDS}s in orb list for interrupted creates, then for each created Machine:"
  echo "+ rsync -a -e 'ssh $ssh_opts' <name>@orb:gate-out/ $run_dir/<name>/"
  echo "+ rsync -a -e 'ssh $ssh_opts' <name>@orb:gate-runner.log $run_dir/<name>/"
  if [ "$keep" -eq 1 ]; then echo '# --keep: no Machine is deleted'; else
    echo "+ orb delete -f <name>   # repeated, up to $DELETE_TRIES times, until orb list -q no longer shows it"
  fi
  echo "# then check orb list -q and append cleanup= to $run_dir/run.env"
  exit 0
fi
trap '' INT TERM

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/machine-process.sh"
source "$script_dir/machine-claims.sh"

# has_line LIST NAME: whether NAME is one line of LIST (no pipe: a pipe into grep -q can
# fail with SIGPIPE under pipefail and read as "absent").
nl='
'
has_line() {
  case "$nl$1$nl" in *"$nl$2$nl"*) return 0 ;; esac
  return 1
}

mkdir -p "$run_dir"
workers='' skipped=''
for pid in $pids; do
  if [ "$(parent_of "$pid")" = "$parent" ]; then workers="$workers $pid"; else skipped="$skipped $pid"; fi
done
printf 'workers to stop:%s\nnot workers of this run, left alone:%s\nrsync and orb run detached with: %s\n' \
  "${workers:- none}" "${skipped:- none}" "$detach" >>"$run_dir/cleanup.log"
# A worker waiting on a command substitution may defer its trap until the control
# query deadline. Let the single supervisor finish before tree escalation.
for pid in $workers; do stop_owned "$pid" "$((CONTROL_SECONDS + 5))"; done

touch "$state_dir/created"
created=$(LC_ALL=C sort -u "$state_dir/created")
inflight=$(cd "$state_dir" && for f in creating.*; do [ ! -e "$f" ] || echo "${f#creating.}"; done)
settle_deadline=$((SECONDS + SETTLE_SECONDS)) missing='' problem=''
while [ -n "$inflight" ]; do
  remaining=$((settle_deadline - SECONDS))
  [ "$remaining" -gt 0 ] || remaining=1
  [ "$remaining" -le "$LIST_SECONDS" ] || remaining=$LIST_SECONDS
  listed=$(bounded "$remaining" orb list -q 2>/dev/null || true) missing=''
  for name in $inflight; do has_line "$listed" "$name" || missing="$missing $name"; done
  [ -n "$missing" ] && [ "$SECONDS" -lt "$settle_deadline" ] || break
  sleep 1
done
if [ -n "$missing" ]; then
  problem="the interrupted create of$missing did not appear within ${SETTLE_SECONDS}s and may still: check orb list, then orb delete -f$missing"
  say "machine-cleanup.sh: $problem"
fi

listed='' existing=''
if [ -n "$created" ] && ! listed=$(bounded "$LIST_SECONDS" orb list -q 2>/dev/null); then
  say 'machine-cleanup.sh: orb list failed; cannot tell which Machines exist'
  listed='' problem="${problem:+$problem; }orb list failed during cleanup: check orb list by hand"
fi
for name in $created; do ! has_line "$listed" "$name" || existing="$existing $name"; done
copied='' uncopied=''
for name in $existing; do
  mkdir -p "$run_dir/$name"
  copy_rc=0
  if bounded "$COPY_SECONDS" rsync -a -e "ssh $ssh_opts" "$name@orb:gate-out/" "$run_dir/$name/" \
    >>"$run_dir/$name/copy-back.log" 2>&1; then copied="$copied $name"; else
    uncopied="$uncopied $name"
    copy_rc=1
    say "machine-cleanup.sh: [$name] no gate-out/ copied back"
  fi
  bounded "$COPY_SECONDS" rsync -a -e "ssh $ssh_opts" "$name@orb:gate-runner.log" "$run_dir/$name/" \
    >>"$run_dir/$name/copy-back.log" 2>&1 || copy_rc=1
  [ "$copy_rc" = 0 ] || echo 'copy-back failed or timed out; evidence may be partial (see copy-back.log)' >"$run_dir/$name/COPY_INFRA"
done
logs="logs copied from:${copied:- none}; not copied from:${uncopied:- none}"

deletes=''
if [ -z "$created" ]; then state=none note='no Machine was created'
elif [ "$keep" -eq 1 ]; then
  state=kept note="kept with --keep (diagnostic only); delete with orb delete -f$existing; $logs"
  say "machine-cleanup.sh: kept:$existing"
else
  # The orb CLI can fail, or even panic, after the daemon deleted the Machine, and can be
  # stopped before it did: orb list decides, the exit codes are only recorded.
  left=''
  for name in $existing; do
    tries=0 codes=''
    while :; do
      rc=0
      bounded "$DELETE_SECONDS" orb delete -f "$name" >>"$run_dir/delete.log" 2>&1 || rc=$?
      tries=$((tries + 1)) codes="$codes${codes:+,}$rc"
      echo "orb delete -f $name: exit $rc (attempt $tries)" >>"$run_dir/delete.log"
      if listed=$(bounded "$LIST_SECONDS" orb list -q 2>/dev/null) && ! has_line "$listed" "$name"; then break; fi
      [ "$tries" -lt "$DELETE_TRIES" ] || break
      sleep 2
    done
    [ "$codes" = 0 ] || say "machine-cleanup.sh: orb delete -f $name exited $codes"
    deletes="$deletes${deletes:+ }$name:$codes"
  done
  if listed=$(bounded "$LIST_SECONDS" orb list -q 2>/dev/null); then
    for name in $created; do ! has_line "$listed" "$name" || left="$left $name"; done
  else
    left=' (orb list failed)'
  fi
  state=deleted note="orb list shows none of them (orb delete -f exit codes: ${deletes:-none ran}); $logs"
  [ -z "$left" ] || problem="${problem:+$problem; }still present:$left; delete by hand with orb delete -f"
  [ -z "$left" ] || say "machine-cleanup.sh: still present:$left"
fi
[ -z "$problem" ] || { state=not-deleted && note="NOT DELETED: $problem"; }
# Claims for untouched names are safe to release; attempted creates remain claimed
# until a complete cleanup confirms absence. Never release another run's token.
if [ -f "$state_dir/claims" ]; then
  for name in $(cat "$state_dir/claims"); do
    if ! has_line "$created" "$name" || [ "$state" = deleted ]; then release_claim "$name"; fi
  done
fi
[ ! -f "$run_dir/run.env" ] ||
  printf 'cleanup=%s\ncleanup_note=%s\ndelete_exit=%s\n' "$state" "$note" "${deletes:-none}" >>"$run_dir/run.env"
[ "$state" != not-deleted ] || exit 4
exit 0
