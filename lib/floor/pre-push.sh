#!/bin/sh
# installed by kiln — do not edit. Regenerate with `kiln doctor --write`.
#
# git has already resolved every ref by the time this runs, so nothing here parses a
# command line. stdin carries: <local ref> <local sha> <remote ref> <remote sha>.
run_if_present() {
  root="$1"
  shift
  [ -f "$root/.kiln/hooks/pre-push.mjs" ] || return 1
  exec node "$root/.kiln/hooks/pre-push.mjs" "$@"
}

# git exports GIT_DIR and GIT_WORK_TREE into every hook, and those beat -C. Left set,
# the walk answered for the starting repository at every step and stopped one level up.
unset GIT_DIR GIT_WORK_TREE

here="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
run_if_present "$here" "$@"
up="$(git -C "$here" rev-parse --show-superproject-working-tree 2>/dev/null)"
while [ -n "$up" ]; do
  run_if_present "$up" "$@"
  up="$(git -C "$up" rev-parse --show-superproject-working-tree 2>/dev/null)"
done

echo "kiln: no .kiln/hooks/pre-push.mjs above $here — not checking this push." >&2
exit 0
