#!/usr/bin/env bash
# Ends an OrbStack Machine gate run (../SKILL.md): stops its workers, copies every
# Machine's logs back and deletes every Machine the run created. machine-gate.sh runs
# it on every exit path; run machine-gate.sh, not this script. macOS bash 3.2 compatible.
set -euo pipefail

# The settle window is an environment variable only so that tests can shorten it.
readonly SETTLE_SECONDS=${BUNQUEUE_MACHINE_SETTLE_SECONDS:-60}
readonly COPY_SECONDS=120

usage() {
  cat <<'EOF'
Usage: machine-cleanup.sh --run-dir DIR --state-dir DIR [--pids "PID ..."]
                          [--parent PID] [--keep] [--dry-run]

1. Stops every worker in --pids with its whole process tree: each process is frozen
   with SIGSTOP before its children are listed, so nothing forks in between, then
   gets SIGTERM, and SIGKILL after 5 s. A pid whose parent is not --parent (default:
   the caller) is skipped: it is not a worker of this run. RUN-DIR/cleanup.log
   records both lists.
2. Waits up to 60 s for Machines whose `orb create` was interrupted
   (STATE-DIR/creating.<name>): the OrbStack daemon can finish a create after its CLI
   is gone. One that has still not appeared may appear later, so the run is then
   recorded as not-deleted, with its name.
3. Copies gate-out/ and gate-runner.log back from every Machine named in
   STATE-DIR/created that exists, each copy bounded to 120 s.
4. Deletes those Machines with `orb delete -f` (not with --keep), logging to
   RUN-DIR/delete.log, then checks that none is left. Only names in STATE-DIR/created
   are deleted: a worker records a name only after checking that no Machine has it.
5. Appends `cleanup=deleted|kept|not-deleted|none` and `cleanup_note=` to RUN-DIR/run.env.

SIGINT and SIGTERM are ignored while it runs, so a second Ctrl-C cannot leave a
Machine behind; it is bounded to about 60 s plus 2 x 120 s per Machine.

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
  echo "# stop the workers ($pids) with their process trees: SIGSTOP, SIGTERM, SIGKILL after 5 s"
  echo "# wait up to ${SETTLE_SECONDS}s in orb list for interrupted creates, then for each created Machine:"
  echo "+ rsync -a -e 'ssh $ssh_opts' <name>@orb:gate-out/ $run_dir/<name>/"
  echo "+ rsync -a -e 'ssh $ssh_opts' <name>@orb:gate-runner.log $run_dir/<name>/"
  if [ "$keep" -eq 1 ]; then echo '# --keep: no Machine is deleted'; else echo '+ orb delete -f <name>'; fi
  echo "# then check orb list -q and append cleanup= to $run_dir/run.env"
  exit 0
fi
trap '' INT TERM

children() {
  local target=$1 stat_file stat rest
  if command -v pgrep >/dev/null 2>&1; then pgrep -P "$target" 2>/dev/null || true && return 0; fi
  for stat_file in /proc/[0-9]*/stat; do
    stat=$(cat "$stat_file" 2>/dev/null) || continue
    rest=${stat##*) }
    set -- $rest
    [ "${2:-}" != "$target" ] || { stat_file=${stat_file#/proc/} && echo "${stat_file%/stat}"; }
  done
}
alive() {
  kill -0 "$1" 2>/dev/null || return 1
  local state=''
  if [ -r "/proc/$1/stat" ]; then state=$(sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d ' ' -f 1)
  elif command -v ps >/dev/null 2>&1; then state=$(ps -o stat= -p "$1" 2>/dev/null || true)
  fi
  case "$state" in Z*) return 1 ;; esac
}
# stop_tree PID: freeze the tree top-down, then TERM, CONT, and KILL what survives 5 s.
stop_tree() {
  local queue=$1 next p kid all='' left='' tries=0
  while [ -n "$queue" ]; do
    next=''
    for p in $queue; do
      kill -STOP "$p" 2>/dev/null || continue
      all="$all $p"
      for kid in $(children "$p"); do next="$next $kid"; done
    done
    queue=$next
  done
  [ -n "$all" ] || return 0
  kill -TERM $all 2>/dev/null || true
  kill -CONT $all 2>/dev/null || true
  while [ "$tries" -lt 10 ]; do
    left=''
    for p in $all; do if alive "$p"; then left="$left $p"; fi; done
    [ -n "$left" ] || return 0
    sleep 0.5 && tries=$((tries + 1))
  done
  kill -KILL $left 2>/dev/null || true
}
# bounded SECONDS CMD...: run CMD, and stop its tree once SECONDS have passed.
bounded() {
  local limit=$1 pid rc=0 ticks=0
  shift
  "$@" &
  pid=$!
  while alive "$pid"; do
    [ "$ticks" -lt $((limit * 2)) ] || { stop_tree "$pid" && break; }
    sleep 0.5 && ticks=$((ticks + 1))
  done
  wait "$pid" 2>/dev/null || rc=$?
  return "$rc"
}

parent_of() {
  if [ -r "/proc/$1/stat" ]; then sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d ' ' -f 2
  elif command -v ps >/dev/null 2>&1; then ps -o ppid= -p "$1" 2>/dev/null | tr -d ' ' || true
  fi
}
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
printf 'workers to stop:%s\nnot workers of this run, left alone:%s\n' "${workers:- none}" "${skipped:- none}" \
  >>"$run_dir/cleanup.log"
for pid in $workers; do stop_tree "$pid"; done

touch "$state_dir/created"
created=$(LC_ALL=C sort -u "$state_dir/created")
inflight=$(cd "$state_dir" && for f in creating.*; do [ ! -e "$f" ] || echo "${f#creating.}"; done)
waited=0 missing='' problem=''
while [ -n "$inflight" ]; do
  listed=$(orb list -q 2>/dev/null || true) missing=''
  for name in $inflight; do has_line "$listed" "$name" || missing="$missing $name"; done
  [ -n "$missing" ] && [ "$waited" -lt "$SETTLE_SECONDS" ] || break
  sleep 1 && waited=$((waited + 1))
done
if [ -n "$missing" ]; then
  problem="the interrupted create of$missing did not appear within ${SETTLE_SECONDS}s and may still: check orb list, then orb delete -f$missing"
  say "machine-cleanup.sh: $problem"
fi

listed='' existing=''
if [ -n "$created" ] && ! listed=$(orb list -q 2>/dev/null); then
  say 'machine-cleanup.sh: orb list failed; cannot tell which Machines exist'
  listed='' problem="${problem:+$problem; }orb list failed during cleanup: check orb list by hand"
fi
for name in $created; do ! has_line "$listed" "$name" || existing="$existing $name"; done
for name in $existing; do
  mkdir -p "$run_dir/$name"
  bounded "$COPY_SECONDS" rsync -a -e "ssh $ssh_opts" "$name@orb:gate-out/" "$run_dir/$name/" \
    >>"$run_dir/$name/copy-back.log" 2>&1 || say "machine-cleanup.sh: [$name] no gate-out/ copied back"
  bounded "$COPY_SECONDS" rsync -a -e "ssh $ssh_opts" "$name@orb:gate-runner.log" "$run_dir/$name/" \
    >>"$run_dir/$name/copy-back.log" 2>&1 || true
done

if [ -z "$created" ]; then state=none note='no Machine was created'
elif [ "$keep" -eq 1 ]; then
  state=kept note="kept with --keep (diagnostic only); delete with orb delete -f$existing"
  say "machine-cleanup.sh: kept:$existing"
else
  for name in $existing; do
    orb delete -f "$name" >>"$run_dir/delete.log" 2>&1 || say "machine-cleanup.sh: orb delete -f $name failed"
  done
  left=''
  if listed=$(orb list -q 2>/dev/null); then
    for name in $created; do ! has_line "$listed" "$name" || left="$left $name"; done
  else
    left=' (orb list failed)'
  fi
  state=deleted note='deleted with orb delete -f after the logs were copied'
  [ -z "$left" ] || problem="${problem:+$problem; }still present:$left; delete by hand with orb delete -f"
  [ -z "$left" ] || say "machine-cleanup.sh: still present:$left"
fi
[ -z "$problem" ] || { state=not-deleted && note="NOT DELETED: $problem"; }
[ ! -f "$run_dir/run.env" ] || printf 'cleanup=%s\ncleanup_note=%s\n' "$state" "$note" >>"$run_dir/run.env"
[ "$state" != not-deleted ] || exit 4
exit 0
