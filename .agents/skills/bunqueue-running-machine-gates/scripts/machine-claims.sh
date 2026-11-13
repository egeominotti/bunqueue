#!/usr/bin/env bash
# Atomic host-wide Machine-name claims; never infer ownership from a name alone.
set -euo pipefail

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    --help) printf 'Usage: machine-claims.sh [--help|--dry-run]\nShared name claims; source from the Machine scripts.\n' ;;
    --dry-run) echo '# shared Machine-name claims; no claim acquired' ;;
    *) echo "machine-claims.sh: unknown option '${1:-}'; source this helper" >&2; exit 2 ;;
  esac
  exit 0
fi

# /tmp is shared across worktrees and independent of per-process TMPDIR settings.
# Tests supply a scratch root shared only by fake gates in the same scenario.
claim_root=${BUNQUEUE_MACHINE_CLAIM_ROOT:-/tmp/bunqueue-machine-claims-$UID}
claim_name() {
  local name=$1
  (umask 077; mkdir -p "$claim_root") || return 1
  mkdir "$claim_root/$name" 2>/dev/null || return 1
  printf '%s\n' "$state_dir" >"$claim_root/$name/owner"
  printf '%s\n' "$name" >>"$state_dir/claims"
}
# Release only this run's claim after the Machine was confirmed absent, or if the
# run never attempted its create. Uncertain claims remain for manual reconciliation.
release_claim() {
  local name=$1 owner=''
  owner=$(cat "$claim_root/$name/owner" 2>/dev/null || true)
  [ "$owner" = "$state_dir" ] || return 0
  rm -f "$claim_root/$name/owner"
  rmdir "$claim_root/$name" 2>/dev/null || true
}
