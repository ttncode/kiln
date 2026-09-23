#!/usr/bin/env bash
# Check that kiln's DNA derivations give what tps-project-dna's own Python gives, over many
# generated stores (D153). Needs a checkout of that project; it is not run in CI, because the
# source is not public.
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
printf '%s of %s generated stores differ\n' "$failed" "$stores"
(( failed == 0 ))
