#!/usr/bin/env bash
# Waits for the GitHub Actions run of a pushed commit and says whether CI is green
# (../SKILL.md, "After the push: watch CI"). It only reads, through the gh CLI: it
# never reruns, cancels, dispatches or approves anything. macOS bash 3.2 compatible.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ci-watch.sh --run <id> [options]
       ci-watch.sh --sha <full commit sha> [--workflow <name>] [options]

Polls, for a bounded time, until the run (--run) or every run of one workflow for a
commit (--sha; workflow CI by default) has finished, then prints one verdict per run
and exits with the worst one (FAILED, then NO VERDICT, then FLAKY, then GREEN):

  GREEN       the latest attempt succeeded and no earlier attempt had a failed job
  FLAKY       the latest attempt succeeded, but only after a rerun: the listed jobs
              failed in an earlier attempt of the same commit. CI is green, and each
              job needs a work item with a reproducing test.
  FAILED      the latest attempt failed; its failed jobs are listed. One attempt
              cannot tell a flake from a regression: a failed matrix leg next to green
              ones can be a real failure of that leg. Read the log, then rerun once.
  NO VERDICT  nothing to judge: gh is missing or fails, no run was found, the run was
              cancelled or skipped, it waits for an approval (a protected environment
              such as npm: that approval is the user's), or it was still running at
              the timeout.

Options:
  --run <id>            Run id (the number in the run URL)
  --sha <sha>           Full 40-character commit SHA (git rev-parse HEAD); gh finds no
                        run for an abbreviated one
  --workflow <name>     Workflow watched with --sha (default: CI)
  --repo <owner/name>   Repository (default: the one of the current directory)
  --timeout <seconds>   Give up after this long (default: 2700, at most 21600)
  --interval <seconds>  Pause between polls (default: 30, at most 600)
  --dry-run             Print the gh commands; run nothing
  -h, --help            Show this help

Exit codes:
  0  GREEN
  1  FAILED
  2  usage error
  3  FLAKY (green only after a rerun)
  4  NO VERDICT
EOF
}

say() { printf '%s\n' "$*" >&2; }
usage_error() {
  say "ci-watch.sh: $*"
  say 'Run with --help for usage.'
  exit 2
}
need_value() { [ "$2" -ge 2 ] || usage_error "$1 needs a value"; }
# Exit 1 means "CI failed" and exit 3 "CI is green": a command that fails under
# set -e must not look like either, so every exit that was not decided becomes 4.
decided=0 worst=0 known_failed=''
worse() { # FAILED > NO VERDICT > FLAKY > GREEN
  case "$worst:$1" in 1:* | 4:3 | 4:0 | 3:0) ;; *) worst=$1 ;; esac
}
quit() {
  decided=1
  exit "$1"
}
no_verdict() {
  echo "NO VERDICT  $*"
  worse 4
  [ -z "$known_failed" ] || echo "FAILED      $known_failed (already observed; diagnostics unavailable)"
  quit "$worst"
}
is_number() {
  case "$1" in '' | *[!0-9]*) return 1 ;; esac
}

run='' sha='' workflow='' repo='' timeout=2700 interval=30 dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    --run) need_value "$1" $# && run=$2 && shift 2 ;;
    --sha) need_value "$1" $# && sha=$2 && shift 2 ;;
    --workflow) need_value "$1" $# && workflow=$2 && shift 2 ;;
    --repo) need_value "$1" $# && repo=$2 && shift 2 ;;
    --timeout) need_value "$1" $# && timeout=$2 && shift 2 ;;
    --interval) need_value "$1" $# && interval=$2 && shift 2 ;;
    --dry-run) dry_run=1 && shift ;;
    -h | --help) usage && exit 0 ;;
    *) usage_error "unknown option '$1'" ;;
  esac
done
[ -n "$run" ] || [ -n "$sha" ] || usage_error '--run <id> or --sha <sha> is required'
[ -z "$run" ] || [ -z "$sha" ] || usage_error '--run and --sha exclude each other'
[ -z "$run" ] || is_number "$run" || usage_error "--run takes a run id, not '$run'"
[ -z "$sha" ] || printf '%s' "$sha" | grep -Eq '^[0-9a-fA-F]{40}$' ||
  usage_error "--sha takes the full 40-character commit SHA, not '$sha'"
[ -z "$workflow" ] || [ -n "$sha" ] || usage_error '--workflow only applies with --sha'
[ -z "$workflow" ] || printf '%s' "$workflow" | grep -Eq '^[A-Za-z0-9 ._/-]+$' ||
  usage_error "bad workflow name '$workflow'"
[ -z "$repo" ] || printf '%s' "$repo" | grep -Eq '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+){1,2}$' ||
  usage_error "bad repository '$repo'"
is_number "$timeout" && [ "$timeout" -ge 1 ] && [ "$timeout" -le 21600 ] ||
  usage_error "--timeout takes 1 to 21600 seconds, not '$timeout'"
is_number "$interval" && [ "$interval" -ge 1 ] && [ "$interval" -le 600 ] ||
  usage_error "--interval takes 1 to 600 seconds, not '$interval'"
workflow=${workflow:-CI}

# The pause is an environment variable only so that tests can shorten it.
readonly PAUSE=${BUNQUEUE_CI_WATCH_PAUSE_SECONDS:-$interval}
readonly RUN_FIELDS='status,conclusion,attempt,headSha,url,workflowName'
readonly RUN_LINE='[.status, (.conclusion // ""), (.attempt | tostring), .headSha, .url, .workflowName] | join("|")'
readonly FAILED_JOBS='.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out") | .name + " (" + .conclusion + ")"'
repo_option=''
[ -z "$repo" ] || repo_option=" --repo $repo"

if [ "$dry_run" -eq 1 ]; then
  echo "ci-watch.sh: dry run; would poll every ${interval}s and give up after ${timeout}s, read-only:"
  [ -z "$sha" ] ||
    echo "+ gh run list --commit $sha --workflow '$workflow' --limit 20 --json databaseId --jq '.[].databaseId'$repo_option"
  echo "+ gh run view ${run:-<id>} --json $RUN_FIELDS --jq '$RUN_LINE'$repo_option"
  echo "+ gh run view ${run:-<id>} [--attempt <n>] --json jobs --jq '$FAILED_JOBS'$repo_option"
  exit 0
fi

active='' capture=''
stop_active() {
  if [ -n "$active" ]; then
    kill -TERM "$active" 2>/dev/null || true
    wait "$active" 2>/dev/null || true
    active=''
  fi
}
cleanup() { stop_active; [ -z "$capture" ] || rm -rf "$capture"; }
interrupt() { trap '' INT TERM; stop_active; no_verdict 'interrupted before the run finished'; }
trap 'code=$?; cleanup; [ "$decided" -eq 1 ] || { echo "NO VERDICT  ci-watch.sh stopped on an internal error (exit $code)" || true; [ "$worst" -eq 1 ] && exit 1; exit 4; }' EXIT
trap interrupt INT TERM
command -v gh >/dev/null 2>&1 || no_verdict 'the gh CLI is not installed (https://cli.github.com)'
command -v bun >/dev/null 2>&1 || no_verdict 'Bun is required to bound gh commands'
helper=$(cd "$(dirname "$0")/../../../../scripts/agents" && pwd)/bounded-command.ts
[ -f "$helper" ] || no_verdict 'the bounded-command.ts helper is unavailable'
started=$(bun "$helper" --now)
is_number "$started" || no_verdict 'the clock helper failed'
until_ms=$((started + timeout * 1000))
capture=$(mktemp -d "${TMPDIR:-/tmp}/bunqueue-ci-watch.XXXXXX")
deadline() { no_verdict "no result after ${timeout}s:${pending:-${last_pending:- gh query timed out}}"; }
# Every gh call, retry pause and history query shares the same wall-clock budget.
bounded() {
  local code=0
  bun "$helper" --until "$until_ms" "$@" >"$capture/reply" &
  active=$!
  wait "$active" || code=$?
  active=''
  return "$code"
}
pause() {
  local code=0
  bounded sleep "$PAUSE" || code=$?
  [ "$code" -ne 124 ] || deadline
  return "$code"
}

# One read through gh; the answer is left in $reply. A blip must not end a long watch
# and an outage must: the third consecutive failure is NO VERDICT.
reply='' failures=0
query() {
  if [ -n "$repo" ]; then set -- "$@" --repo "$repo"; fi
  local code=0
  bounded gh run "$@" || code=$?
  reply=$(cat "$capture/reply")
  if [ "$code" -eq 0 ]; then
    failures=0
    return 0
  fi
  [ "$code" -ne 124 ] || deadline
  failures=$((failures + 1))
  [ "$failures" -lt 3 ] || no_verdict "gh run $1 failed $failures times in a row (is gh authenticated? gh auth status)"
  return 1
}
must_query() {
  until query "$@"; do pause; done
}

# Sets $status, $conclusion, $attempt, $head, $url and $name of run $1.
read_run() {
  IFS='|' read -r status conclusion attempt head url name <<EOF
$reply
EOF
  is_number "$attempt" || no_verdict "unexpected answer from gh for run $1: $reply"
  case "$status:$conclusion" in
    completed:failure | completed:timed_out | completed:startup_failure)
      known_failed="$name run $1 (attempt $attempt): $url"
      worse 1
      ;;
  esac
}

# Wait until every run has finished, or waits for an approval nobody here may give.
ids=$run
while :; do
  last_pending=${pending:-}
  pending=''
  if [ -n "$sha" ]; then
    if query list --commit "$sha" --workflow "$workflow" --limit 20 --json databaseId --jq '.[].databaseId'; then
      ids=$(printf '%s' "$reply" | tr '\n' ' ')
      [ -n "$ids" ] || pending=" no $workflow run for $sha yet"
      for id in $ids; do is_number "$id" || no_verdict "unexpected answer from gh run list: $reply"; done
    else
      pending=' gh failed'
    fi
  fi
  for id in $ids; do
    [ "$pending" != ' gh failed' ] || break
    if query view "$id" --json "$RUN_FIELDS" --jq "$RUN_LINE"; then
      read_run "$id"
      case "$status" in
        completed | waiting) ;;
        *) pending="$pending run $id is $status;" ;;
      esac
    else
      pending=' gh failed'
    fi
  done
  [ -n "$pending" ] || break
  now=$(bun "$helper" --now)
  elapsed=$(((now - started) / 1000))
  [ "$now" -lt "$until_ms" ] || deadline
  say "ci-watch.sh: ${elapsed}s of ${timeout}s:$pending"
  pause
done

# Collects history in the parent shell: a long command substitution defers traps.
failed_jobs() {
  local n=$2
  job_lines=''
  while [ "$n" -le "$3" ]; do
    must_query view "$1" --attempt "$n" --json jobs --jq "$FAILED_JOBS"
    if [ -n "$reply" ]; then
      job_lines="$job_lines$(printf '%s\n' "$reply" | sed "s/^/    attempt $n: /")
"
    fi
    n=$((n + 1))
  done
}

for id in $ids; do
  must_query view "$id" --json "$RUN_FIELDS" --jq "$RUN_LINE"
  read_run "$id"
  label="$name run $id (attempt $attempt, commit $(printf '%s' "$head" | cut -c1-8)): $url"
  if [ "$status" != completed ]; then
    echo "NO VERDICT  $label"
    echo "    it waits for an approval (a protected environment such as npm). That approval"
    echo "    is the user's: ask for it, then run ci-watch.sh again."
    worse 4
    continue
  fi
  failed_jobs "$id" 1 $((attempt - 1))
  earlier=$job_lines
  case "$conclusion" in
    success)
      if [ -z "$earlier" ]; then
        echo "GREEN       $label"
        worse 0
      else
        echo "FLAKY       $label"
        echo "    green only after a rerun; the same commit failed first in:"
        printf '%s\n' "$earlier"
        echo "    Record a work item per job (feature_list.json): the failing test, this run,"
        echo "    and a reproducing test before any fix. A flake is never silently ignored."
        worse 3
      fi
      ;;
    failure | timed_out | startup_failure)
      echo "FAILED      $label"
      worse 1
      failed_jobs "$id" "$attempt" "$attempt"
      [ -z "$job_lines" ] || printf '%s' "$job_lines"
      if [ -n "$earlier" ]; then
        printf '%s\n' "$earlier"
        echo "    It failed again on a rerun of the same commit: treat a job that fails in every"
        echo "    attempt as a regression or a broken runner, not as a flake."
      fi
      echo "    read it:    gh run view $id --log-failed$repo_option"
      [ "$attempt" -gt 1 ] ||
        echo "    rerun once: gh run rerun $id --failed$repo_option   (then ci-watch.sh again)"
      worse 1
      ;;
    *)
      echo "NO VERDICT  $label"
      echo "    the run ended as '${conclusion:-unknown}': neither a pass nor a failure of the commit."
      worse 4
      ;;
  esac
done
quit "$worst"
