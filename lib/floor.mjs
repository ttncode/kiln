import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { checkoutsUnder } from "./guards/git-repo.mjs";
import { gitOutput } from "./init.mjs";

/**
 * The layer that sees a command *after* git has resolved it.
 *
 * kiln's `PreToolUse` hook reads a command line, and a command line does not say which
 * checkout, which branch, or which config were in play — git computes those in more ways
 * than any scan enumerates. A `pre-push` hook is handed the answer: git writes the
 * resolved source and destination refs on stdin, one line per ref, after everything has
 * been worked out. Nothing is parsed.
 *
 * It is a floor, not a ceiling: `--no-verify` and `core.hooksPath` switch it off, which is
 * why `lib/guards/verification.mjs` refuses those. Two layers, each doing the job the
 * other cannot.
 */
const MARKER = "# installed by kiln";

export function hookBody() {
  return `#!/bin/sh
${MARKER} — do not edit. Regenerate with \`kiln doctor --write\`.
#
# git has already resolved every ref by the time this runs, so nothing here parses a
# command line. stdin carries: <local ref> <local sha> <remote ref> <remote sha>.
exec node "$(git rev-parse --show-toplevel)/.kiln/hooks/pre-push.mjs" "$@"
`;
}

/** The runner is a real file in this repository, so it is linted and tested like any other. */
export function runnerBody() {
  return readFileSync(new URL("floor/pre-push.mjs", import.meta.url), "utf8");
}

export function runnerPath(root) {
  return join(root, ".kiln", "hooks", "pre-push.mjs");
}

/**
 * `core.hooksPath` is not an obstacle; it is where the hooks live. husky sets it to
 * `.husky`, pre-commit sets it to its own directory, and every hook-aware tool installs
 * into whatever it points at — so kiln does too.
 *
 * Writing to `.git/hooks` while git reads somewhere else meant the floor was **absent on
 * every husky project**, which is an enormous share of JavaScript repositories. Measured on
 * a real clone: no hook installed, `doctor` printed `Ready.`, and a real push to a
 * protected branch succeeded.
 */
function hookDir(checkout) {
  const configured = gitOutput(checkout, ["config", "--get", "core.hooksPath"]);
  if (!configured) {
    const dir = gitOutput(checkout, ["rev-parse", "--absolute-git-dir"]);
    return dir ? { dir: join(dir, "hooks"), managed: false } : null;
  }
  return isAbsolute(configured)
    ? { dir: configured, managed: true, outside: !configured.startsWith(checkout) }
    : { dir: join(checkout, configured), managed: true, outside: false };
}

/**
 * Three answers, never a silent one. `installed` is kiln's own file; `foreign` is a hook
 * that was already there — never overwritten, because a project's own hook is not kiln's
 * to replace; `shadowed` is a `core.hooksPath` pointing elsewhere, where the file kiln
 * writes would simply never run.
 */
export function floorStatus(root) {
  return checkoutsUnder(root).map((checkout) => {
    const found = hookDir(checkout);
    if (!found) return { checkout, state: "not-a-repo" };
    const path = join(found.dir, "pre-push");
    if (found.outside) return { checkout, path, state: "elsewhere" };
    if (!existsSync(path)) return { checkout, path, state: "missing" };
    return { checkout, path, state: readFileSync(path, "utf8").includes(MARKER) ? "installed" : "foreign" };
  });
}

/** Writes only what is missing, which is the same law `kiln init` follows for every file. */
export function installFloor(root) {
  const runner = runnerPath(root);
  mkdirSync(join(root, ".kiln", "hooks"), { recursive: true });
  if (!existsSync(runner)) writeFileSync(runner, runnerBody(), "utf8");

  const written = [];
  for (const row of floorStatus(root)) {
    if (row.state !== "missing") continue;
    mkdirSync(join(row.path, ".."), { recursive: true });
    writeFileSync(row.path, hookBody(), "utf8");
    chmodSync(row.path, 0o755);
    written.push(row.path);
  }
  return written;
}
