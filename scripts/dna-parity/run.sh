#!/usr/bin/env bash
# Check that kiln's DNA derivations, context footprint and panel reconciliation give what
# tps-project-dna's own Python gives, over many generated inputs (D153, D165, D166). Needs a checkout of that project; it is not run
# in CI, because the source is not public.
#
# Usage:   run.sh <tps-project-dna scripts dir> [stores]
# Example: run.sh ~/claude_skill/plugins/tps-project-dna/skills/tps-project-dna/scripts 300
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly HERE

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

source_dir="${1:?usage: run.sh <tps-project-dna scripts dir> [stores]}"
stores="${2:-300}"
[[ -f "${source_dir}/build_dna_store.py" ]] || die "no build_dna_store.py in ${source_dir}"
command -v python3 >/dev/null || die "python3 is required"

work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT

failed=0
for seed in $(seq 1 "$stores"); do
  node "${HERE}/generate.mjs" "${work_dir}/${seed}" "$seed"
  if ! python3 "${HERE}/compare.py" "${work_dir}/${seed}" "$source_dir"; then
    printf 'seed %s differs\n' "$seed"
    failed=$(( failed + 1 ))
  fi
done
printf '%s of %s generated stores differ in their derivations\n' "$failed" "$stores"

footprint_failed=0
for seed in $(seq 1 "$stores"); do
  if ! node "${HERE}/footprint.mjs" "${work_dir}/footprint-${seed}" "$seed" | python3 "${HERE}/compare-footprint.py" "${work_dir}/footprint-${seed}" "$source_dir"; then
    printf 'footprint seed %s differs\n' "$seed"
    footprint_failed=$(( footprint_failed + 1 ))
  fi
done
printf '%s of %s generated stores differ in their context footprint\n' "$footprint_failed" "$stores"

reconcile_failed=0
for seed in $(seq 1 "$stores"); do
  if ! node "${HERE}/reconcile.mjs" "${work_dir}/reconcile-${seed}" "$seed" | python3 "${HERE}/compare-reconcile.py" "${work_dir}/reconcile-${seed}" "$source_dir"; then
    printf 'reconcile seed %s differs\n' "$seed"
    reconcile_failed=$(( reconcile_failed + 1 ))
  fi
done
printf '%s of %s generated panel sets differ in their reconciliation\n' "$reconcile_failed" "$stores"
(( failed == 0 && footprint_failed == 0 && reconcile_failed == 0 ))
