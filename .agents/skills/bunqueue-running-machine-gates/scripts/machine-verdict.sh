#!/usr/bin/env bash
# The verdict of an OrbStack Machine gate run (../SKILL.md): reads a run directory that
# machine-gate.sh wrote, prints its manifest.md and exits with the verdict. Run it; it
# only reads files. Compatible with the bash 3.2 that macOS ships.
set -euo pipefail

readonly ALL_STEPS='unit,tcp,embedded,typecheck,format,tinyfs'

usage() {
  cat <<'EOF'
Usage: machine-verdict.sh [--dry-run] <run-dir>

Classifies every Machine of a machine-gate.sh run directory (run.env, and per Machine
steps.tsv, the step logs, environment.txt, DONE or INFRA), prints the manifest in
Markdown on stdout and exits with the verdict; machine-gate.sh writes that output to
manifest.md, and `machine-gate.sh --classify <run-dir>` is this call.

A Machine passes when every requested step exited 0. Its unit failure is the known
environment gap only when the failed tests are exactly the file and title pairs of
../assets/known-node-gap.txt, the log shows `node: command not found` and no
unhandled error, the as-is rerun (gap-asis) fails on the same pairs and the
node->bun shim rerun (gap-shim) passes. Anything else is a real failure.

Release evidence needs: Ubuntu 24.04 among the distros (Debian 13 too for a
release), every step, and every Machine deleted. A passing run with a step subset, no
Ubuntu 24.04 Machine or Machines kept with --keep is DIAGNOSTIC (exit 5); a run
whose cleanup is not recorded, or failed, cannot prove its Machines are gone (exit 4).

Options:
  --dry-run   Print the files it would read; classify nothing
  -h, --help  Show this help

Exit codes:
  4    a Machine not deleted or no recorded cleanup (this outranks an interrupt), or
       an INFRA marker or no Machine at all (a real failure outranks those)
  130  the run was interrupted and every Machine deleted: no evidence
  1    a real failure in at least one Machine
  5    diagnostic: passed (or only the known gap) but not evidence
  3    evidence; only the known environment gap failed
  0    evidence; every step passed in every Machine (release evidence needs both
       ubuntu:24.04 and debian:13; ubuntu:24.04 alone is evidence for a candidate)
  2    usage error
EOF
}

usage_error() {
  printf 'machine-verdict.sh: %s\nRun with --help for usage.\n' "$*" >&2
  exit 2
}

dir='' dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 && shift ;;
    -h | --help) usage && exit 0 ;;
    -*) usage_error "unknown option '$1'" ;;
    *) [ -z "$dir" ] || usage_error 'one run directory only'
       dir=$1 && shift ;;
  esac
done
[ -n "$dir" ] || usage_error 'a run directory is required'
gap_file="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/assets/known-node-gap.txt"
[ -f "$gap_file" ] || { printf 'machine-verdict.sh: missing %s\n' "$gap_file" >&2 && exit 4; }
[ -d "$dir" ] || { printf 'machine-verdict.sh: no run directory %s\n' "$dir" >&2 && exit 4; }
if [ "$dry_run" -eq 1 ]; then
  echo "machine-verdict.sh: dry run; would read $dir/run.env, $gap_file and, per Machine,"
  echo '  steps.tsv, DONE, INFRA, environment.txt and the step logs; classifies nothing'
  exit 0
fi

tab=$(printf '\t')
# Missing files read as empty: under `set -e -o pipefail` a failed read would end the
# script before it prints a manifest.
kv() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -n 1 || true; }
env_line() { sed -n "s/^$2: //p" "$1/environment.txt" 2>/dev/null | head -n 1 || true; }
step_field() { awk -F '\t' -v s="$2" -v c="$3" '$1 == s { print $c; exit }' "$1/steps.tsv" 2>/dev/null || true; }
count_word() { sed -n -E "s/^ *([0-9]+) $2s?\$/\1/p" "$1" 2>/dev/null | tail -n 1 || true; }
# "<file> <title>" for every (fail) line, attributed to the file header bun printed
# before it; the recap after "N tests failed:" repeats titles without files.
failed_pairs() {
  awk '/^[0-9]+ tests? failed:$/ { exit }
    /^[^[:space:]][^:]*\.(test|spec)\.[cm]?[jt]sx?:$/ { file = substr($0, 1, length($0) - 1); next }
    /^\(fail\) / { t = substr($0, 8); sub(/ \[[0-9.]+(ms|s)\]$/, "", t); print (file == "" ? "?" : file) " " t }' \
    "$1" 2>/dev/null | LC_ALL=C sort -u || true
}
known_pairs() { sed -n 's/^test //p' "$gap_file" | LC_ALL=C sort -u; }

# gap_reason DIR: why the unit failure is (status 0) or is not (status 1) the known gap.
gap_reason() {
  local dir=$1 log="$1/unit.log" expected n fails errors
  expected=$(known_pairs)
  n=$(printf '%s\n' "$expected" | grep -c .)
  grep -Eq '^Ran [0-9]+ tests? across' "$log" 2>/dev/null ||
    { echo 'the unit run did not finish (no "Ran N tests" summary)' && return 1; }
  fails=$(count_word "$log" fail)
  [ "${fails:-0}" = "$n" ] || { echo "${fails:-0} unit failures, the known gap has $n" && return 1; }
  errors=$(count_word "$log" error)
  [ "${errors:-0}" = 0 ] || { echo "$errors unhandled errors" && return 1; }
  if grep -q '^# Unhandled error between tests' "$log"; then echo 'an unhandled error between tests' && return 1; fi
  if [ "$(failed_pairs "$log")" != "$expected" ]; then
    echo "the failing tests are not the known gap: $(failed_pairs "$log" | grep -vxF "$expected" | head -n 3 | tr '\n' ';')"
    return 1
  fi
  grep -q 'node: command not found' "$log" || { echo 'no "node: command not found" in the unit log' && return 1; }
  [ -n "$(step_field "$dir" gap-asis 2)" ] || { echo 'the gap files were not rerun' && return 1; }
  [ "$(step_field "$dir" gap-asis 2)" != 0 ] || { echo 'the gap files pass without the shim: not the known gap' && return 1; }
  [ "$(failed_pairs "$dir/gap-asis.log")" = "$expected" ] || { echo 'the as-is rerun failed differently' && return 1; }
  [ "$(step_field "$dir" gap-shim 2)" = 0 ] && [ "$(count_word "$dir/gap-shim.log" fail)" = 0 ] ||
    { echo 'the gap files still fail with the node->bun shim' && return 1; }
  echo "exactly the $n known node-dependent unit tests failed (node: command not found); they pass with a node->bun shim"
}

# classify_machine DIR STEPS: prints "<pass|known-gap|fail|infra><TAB><reason>".
classify_machine() {
  local dir=$1 wanted=$2 step rc bad='' reason
  if [ -f "$dir/INFRA" ]; then printf 'infra\t%s\n' "$(head -n 1 "$dir/INFRA")" && return; fi
  [ -f "$dir/steps.tsv" ] && [ -f "$dir/DONE" ] ||
    { printf 'fail\tthe Machine run did not finish (no steps.tsv or DONE)\n' && return; }
  for step in install build-client $(printf '%s' "$wanted" | tr ',' ' '); do
    rc=$(step_field "$dir" "$step" 2)
    if [ -z "$rc" ]; then bad="$bad $step(missing)"; elif [ "$rc" != 0 ] && [ "$step" != unit ]; then bad="$bad $step(exit $rc)"; fi
  done
  [ -z "$bad" ] || { printf 'fail\tfailed:%s\n' "$bad" && return; }
  rc=$(step_field "$dir" unit 2)
  if [ -z "$rc" ] || [ "$rc" = 0 ]; then printf 'pass\tevery step passed\n' && return; fi
  if reason=$(gap_reason "$dir"); then printf 'known-gap\t%s\n' "$reason"; else printf 'fail\tunit: %s\n' "$reason"; fi
}

step_totals() {
  local log="$1/$2.log"
  [ -f "$log" ] || { echo '-' && return; }
  case "$2" in
    unit | tinyfs | gap-asis | gap-shim)
      printf '%s pass / %s fail / %s skip; %s' "$(count_word "$log" pass)" "$(count_word "$log" fail)" \
        "$(count_word "$log" skip | grep . || echo 0)" "$(grep -E '^Ran [0-9]+ tests? across' "$log" | tail -n 1 | sed -E 's/ \[.*//')"
      ;;
    tcp) grep -E '^(Suites|Assertions): ' "$log" | tail -n 2 | tr '\n' ';' ;;
    embedded) grep -Eo '(Test Suites|Individual Tests): [0-9]+/[0-9]+ passed' "$log" | tail -n 2 | tr '\n' ';' ;;
    typecheck) grep -Eo 'No type errors in [0-9,]+ files|[0-9]+ errors?' "$log" | tr '\n' ';' ;;
    format) grep -Eo 'All [0-9]+ files are formatted|[0-9]+ files? (would be|are not) [a-z ]+' "$log" | head -n 1 ;;
    *) tail -n 1 "$log" | cut -c 1-80 ;;
  esac
}

machine_dirs() {
  local name
  for name in $(kv "$1/run.env" machines | tr ',' ' '); do echo "$1/$name"; done
  [ -n "$(kv "$1/run.env" machines)" ] ||
    find "$1" -mindepth 2 -maxdepth 2 \( -name steps.tsv -o -name INFRA \) -exec dirname {} \; | LC_ALL=C sort -u || true
}

machine_section() {
  local m=$1 verdict=$2 reason=$3
  cat <<EOF

### $(basename "$m"): $verdict

$reason

| Field | Value |
|---|---|
| OS | $(env_line "$m" os) |
| Arch / kernel | $(env_line "$m" arch) / $(env_line "$m" kernel) |
| cgroup cpu.max / memory.max / swap | $(env_line "$m" cgroup.cpu.max) / $(env_line "$m" cgroup.memory.max) / $(env_line "$m" cgroup.memory.swap.max) |
| Bun / node | $(env_line "$m" bun) / $(env_line "$m" node) |
| Time zone | $(env_line "$m" tz) |

| Step | Exit | Seconds | Totals |
|---|---:|---:|---|
EOF
  [ -f "$m/steps.tsv" ] || return 0
  awk -F '\t' 'NR > 1 { print $1 "\t" $2 "\t" $3 }' "$m/steps.tsv" |
    while IFS="$tab" read -r s rc secs; do
      printf '| %s | %s | %s | %s |\n' "$s" "$rc" "$secs" "$(step_totals "$m" "$s")"
    done
}

env_file="$dir/run.env"
wanted=$(kv "$env_file" steps)
wanted=${wanted:-$ALL_STEPS}
distros=$(kv "$env_file" distros)
cleanup=$(kv "$env_file" cleanup)
worst=0 count=0 body=''
for m in $(machine_dirs "$dir"); do
  count=$((count + 1))
  verdict=$(classify_machine "$m" "$wanted")
  reason=${verdict#*"$tab"}
  verdict=${verdict%%"$tab"*}
  case "$verdict" in
    fail) worst=1 ;;
    infra) [ "$worst" = 1 ] || worst=4 ;;
    known-gap) [ "$worst" != 0 ] || worst=3 ;;
  esac
  body="$body$(machine_section "$m" "$verdict" "$reason")
"
done
[ "$count" -gt 0 ] || [ "$worst" = 1 ] || worst=4

evidence='' scope='' uncleaned=0
case ",$distros," in *,ubuntu:24.04,*) ;; *) evidence="no Ubuntu 24.04 Machine" ;; esac
[ "$wanted" = "$ALL_STEPS" ] || evidence="${evidence:+$evidence; }steps $wanted only"
case ",$distros," in
  *,ubuntu:24.04,*debian:13,* | *,debian:13,*ubuntu:24.04,*) scope='release scope (Ubuntu 24.04 and Debian 13)' ;;
  *) scope="distros $distros: candidate scope (a release also needs Debian 13)" ;;
esac
case "$cleanup" in
  deleted | none) ;;
  kept) evidence="${evidence:+$evidence; }Machines kept with --keep" ;;
  not-deleted) uncleaned=1 ;;
  *) uncleaned=1 cleanup='not recorded' ;;
esac
[ "$uncleaned" = 0 ] || [ "$worst" = 1 ] || worst=4
if [ "$(kv "$env_file" interrupted)" = yes ]; then
  # Interrupted: nothing is claimed, but a Machine left behind still has to surface.
  if [ "$uncleaned" = 1 ]; then worst=4; else worst=130; fi
elif [ -n "$evidence" ] && { [ "$worst" = 0 ] || [ "$worst" = 3 ]; }; then
  worst=5
fi
case "$worst" in
  0) label='PASS' ;;
  1) label='FAIL' ;;
  3) label='KNOWN ENVIRONMENT GAP (the canonical result for Bun-only Machines)' ;;
  5) label="DIAGNOSTIC: not release evidence ($evidence)" ;;
  130) label='INTERRUPTED: no evidence' ;;
  *)
    label='INFRASTRUCTURE FAILURE: no evidence'
    [ "$uncleaned" = 0 ] || label="$label; Machines not deleted or cleanup not recorded" ;;
esac

cat <<EOF
# OrbStack Machine gate, run $(kv "$env_file" run_id)

- Verdict: **$label** (exit $worst)
- Tree: \`$(kv "$env_file" tree)\`; archive sha256 \`$(kv "$env_file" archive_sha256)\`; content hash \`$(kv "$env_file" content_hash)\` ($(kv "$env_file" files) files)
- Scope: $scope; steps $wanted
- Host: $(kv "$env_file" host); OrbStack $(kv "$env_file" orb); repository HEAD \`$(kv "$env_file" head)\`
- Created with: \`orb create --isolated --isolate-network --arch $(kv "$env_file" arch) --cpus 4 --memory 16G --disk 32G <distro> <name>\`; copied with rsync over \`ssh -o ForwardAgent=no -o ClearAllForwardings=yes\`
- Not in the snapshot: $(kv "$env_file" outside)
- Machines: ${cleanup:-unknown}; $(kv "$env_file" cleanup_note)
- Started / finished (UTC): $(kv "$env_file" started) / $(kv "$env_file" finished)
$body
EOF
[ "$worst" != 3 ] || cat <<'EOF'
## Known environment gap

The Machines are Bun-only. The tests listed in the skill's `assets/known-node-gap.txt`
run CI's version-gate step, which calls `node -p`, so they exit 127 there and pass in
the sandbox (oven/bun ships a node->bun fallback) and on GitHub (real Node). Verdict 3
means exactly those tests failed, with `node: command not found`, and passed again with
a node->bun shim appended to PATH; every other step passed.
EOF
exit "$worst"
