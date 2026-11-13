#!/usr/bin/env bash
# Shared owned-process control for Machine workers and cleanup (Bash 3.2).
set -euo pipefail

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    --help) printf 'Usage: machine-process.sh [--help|--dry-run]\nShared process helpers; source from the Machine scripts.\n' ;;
    --dry-run) echo '# shared owned-process helpers; no process started' ;;
    *) echo "machine-process.sh: unknown option '${1:-}'; source this helper" >&2; exit 2 ;;
  esac
  exit 0
fi

readonly CONTROL_SECONDS=${BUNQUEUE_MACHINE_CONTROL_SECONDS:-30}

children() {
  local target=$1 stat_file stat rest
  if command -v pgrep >/dev/null 2>&1; then pgrep -P "$target" 2>/dev/null || true; return 0; fi
  for stat_file in /proc/[0-9]*/stat; do
    stat=$(cat "$stat_file" 2>/dev/null) || continue
    rest=${stat##*) }
    set -- $rest
    [ "${2:-}" != "$target" ] || { stat_file=${stat_file#/proc/}; echo "${stat_file%/stat}"; }
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
parent_of() {
  if [ -r "/proc/$1/stat" ]; then sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d ' ' -f 2
  elif command -v ps >/dev/null 2>&1; then ps -o ppid= -p "$1" 2>/dev/null | tr -d ' ' || true
  fi
}
# Freeze top-down before enumerating children: a stopped parent cannot fork a child
# between enumeration and termination. Only the caller's verified roots are passed.
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

# A delegated supervisor owns its descendants. Give it the signal first so its
# group cleanup does not race a second tree controller; freeze/escalate only if
# the verified owned root fails to finish within the grace period.
stop_owned() {
  local pid=$1 grace=${2:-5} ticks=0
  kill -TERM "$pid" 2>/dev/null || return 0
  while alive "$pid" && [ "$ticks" -lt $((grace * 10)) ]; do
    sleep 0.1 && ticks=$((ticks + 1))
  done
  if alive "$pid"; then stop_tree "$pid"; fi
}

detach=none
if command -v setsid >/dev/null 2>&1; then detach=setsid; elif command -v perl >/dev/null 2>&1; then detach=perl; fi
detached() {
  case "$detach" in
    setsid) exec setsid "$@" ;;
    perl) exec perl -MPOSIX -e 'setsid(); exec { $ARGV[0] } @ARGV or exit 127' "$@" ;;
    *) exec "$@" ;;
  esac
}

current_pid=''
readonly bounded_helper="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)/scripts/agents/bounded-command.ts"
# The shared helper owns a fresh group through pipe closure, even after its launcher
# exits. It also removes silent descendants before returning. Keep the helper as an
# owned child so worker/preflight/cleanup signal handlers can stop and reap it.
bounded() {
  local limit=$1 deadline pid rc=0
  shift
  deadline=$(bun "$bounded_helper" --now) || return 125
  deadline=$((deadline + limit * 1000))
  if [ -n "${bounded_log:-}" ]; then
    detached bun "$bounded_helper" --until "$deadline" "$@" >>"$bounded_log" 2>&1 </dev/null &
  else
    detached bun "$bounded_helper" --until "$deadline" "$@" </dev/null &
  fi
  pid=$! current_pid=$!
  wait "$pid" 2>/dev/null || rc=$?
  current_pid=''
  return "$rc"
}
