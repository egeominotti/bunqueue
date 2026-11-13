#!/usr/bin/env bash
# Validate final results independently of the Machine's step exit receipts.
set -euo pipefail

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    --help) printf 'Usage: machine-evidence.sh [--help|--dry-run]\nShared log validation; source from machine-verdict.sh.\n' ;;
    --dry-run) echo '# shared result-summary validation; no files read' ;;
    *) echo "machine-evidence.sh: unknown option '${1:-}'; source this helper" >&2; exit 2 ;;
  esac
  exit 0
fi

# log_status FILE STEP: pass, fail (reported tests/errors), or infra (no complete,
# nonempty, internally consistent result). Use portable awk, including on macOS.
log_status() {
  awk -v kind="$2" '
    function ratio(line, parts, words) {
      sub(/^.*: */, "", line)
      split(line, words, " "); split(words[1], parts, "/")
      p = parts[1] + 0; t = parts[2] + 0
      valid = t > 0 && p <= t
      if (valid && p < t) failures = 1
    }
    {
      gsub(/\033\[[0-9;]*[A-Za-z]/, "")
      if (kind == "unit" || kind == "tinyfs") {
        if ($0 ~ /^[ \t]*[0-9]+ pass$/) { pass = $1; pass_at = NR; skipped = 0; skip_at = 0 }
        if ($0 ~ /^[ \t]*[0-9]+ skip$/) { skipped = $1; skip_at = NR }
        if ($0 ~ /^[ \t]*[0-9]+ fail$/) { fail = $1; fail_at = NR }
        if ($0 ~ /^[ \t]*[1-9][0-9]* errors?$/) failures = 1
        if ($0 ~ /^Ran [0-9]+ tests? across [0-9]+ files?([. ]|$)/) {
          ran = $2; files = $5; summary_at = NR
        }
      } else if (kind == "tcp" || kind == "embedded") {
        if ((kind == "tcp" && $0 ~ /^Suites: [0-9]+\/[0-9]+ passed[ \t]*$/) ||
            (kind == "embedded" && $0 ~ /Test Suites: [0-9]+\/[0-9]+ passed[ \t]*$/)) {
          ratio($0); suites_ok = valid; suites_at = NR
        }
        if ((kind == "tcp" && $0 ~ /^Assertions: [0-9]+\/[0-9]+ passed[ \t]*$/) ||
            (kind == "embedded" && $0 ~ /Individual Tests: [0-9]+\/[0-9]+ passed[ \t]*$/)) {
          ratio($0); assertions_ok = valid; assertions_at = NR
        }
      } else if (kind == "typecheck") {
        if ($0 ~ /No type errors in [1-9][0-9,]* files/) completed++
        if ($0 ~ /^[ \t]*[1-9][0-9]* errors?([ .:]|$)/) failures = 1
      } else if (kind == "format") {
        if ($0 ~ /All [1-9][0-9]* files are formatted/) completed++
        if ($0 ~ /^[ \t]*[1-9][0-9]* files? needs? formatting[. ]/) failures = 1
      }
    }
    END {
      if (kind == "unit" || kind == "tinyfs") {
        if (failures || (fail_at && fail > 0)) print "fail"
        else if (pass_at && fail_at && pass > 0 && files > 0 && ran == pass + fail + skipped &&
                 summary_at > pass_at && summary_at > fail_at && summary_at > skip_at) print "pass"
        else print "infra"
      } else if (failures) print "fail"
      else if (kind == "tcp" || kind == "embedded") {
        if (suites_ok && assertions_ok && assertions_at > suites_at) print "pass"
        else print "infra"
      } else if (kind == "typecheck" && completed >= 2) print "pass"
      else if (kind == "format" && completed >= 1) print "pass"
      else print "infra"
    }
  ' "$1"
}
