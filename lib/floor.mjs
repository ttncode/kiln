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

/**
 * `--show-toplevel` inside a submodule is the submodule, which git's own documentation
 * says plainly — so the hook installed into AdminPage looked for
 * `AdminPage/.kiln/hooks/pre-push.mjs`, and `.kiln/` exists only in the superproject.
 * Measured on a real monorepo: every push from every one of four submodules died with
 * `Cannot find module`, before the floor could evaluate anything. The branch being pushed
 * was not even protected.
 *
 * `--show-superproject-working-tree` is the primitive for the question actually being
 * asked, and it is empty when there is no superproject. The walk takes the **first**
 * checkout upward that has a runner rather than the outermost: a project whose kiln lives
 * in the submodule, nested inside some larger repository, would otherwise be answered with
 * a stranger's configuration.
 *
 * And no runner anywhere means kiln is not driving this repository, which is D33 — allow,
 * and say so once. A floor that refuses a push it cannot judge is not a floor, it is a
 * wall, and that is exactly what a real run hit.
 *
 * The walk also has to clear `GIT_DIR` and `GIT_WORK_TREE` first: git exports both into
 * every hook, and they beat `-C`. Measured with them left set, a submodule two levels deep
 * got an empty answer at the second step and its push was allowed unchecked.
 */
export function hookBody() {
  return readFileSync(new URL("floor/pre-push.sh", import.meta.url), "utf8");
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
/**
 * git already resolves this, and it accounts for things kiln was computing one at a time:
 * `core.hooksPath`, and — the one that was missed — the **common** directory, which is
 * where a linked worktree reads its hooks from.
 *
 * Measured in a `git worktree`: `--absolute-git-dir` is `.git/worktrees/<name>`, so kiln
 * installed at `.git/worktrees/<name>/hooks/pre-push`, `floorStatus` read it back as
 * `installed`, `doctor` printed `Ready.` — and git reads `.git/hooks`, where nothing was.
 * A real push to a protected branch succeeded, exit 0. That is D7 item 1 reported as held
 * while absent, the same shape as the husky bug this function was written to fix, one
 * directory over.
 *
 * `git rev-parse --git-path hooks` answers all of it in one call.
 */
function hookDir(checkout) {
  const resolved = gitOutput(checkout, ["rev-parse", "--git-path", "hooks"]);
  if (!resolved) return null;
  const dir = isAbsolute(resolved) ? resolved : join(checkout, resolved);
  const configured = gitOutput(checkout, ["config", "--get", "core.hooksPath"]);
  const outside = Boolean(configured) && isAbsolute(configured) && !configured.startsWith(checkout);
  return { dir, managed: Boolean(configured), outside };
}

/**
 * Three answers, never a silent one. `installed` is kiln's own file; `foreign` is a hook
 * that was already there — never overwritten, because a project's own hook is not kiln's
 * to replace; `shadowed` is a `core.hooksPath` pointing elsewhere, where the file kiln
 * writes would simply never run.
 */
/**
 * The same walk the hook performs, asked here so `doctor` reports what will happen rather
 * than that a file exists. A hook present and a hook able to run are different facts, and
 * on a real monorepo they differed in every submodule while doctor said `Ready.`
 */
function runnerReachable(checkout) {
  let dir = checkout;
  while (dir) {
    if (existsSync(runnerPath(dir))) return true;
    dir = gitOutput(dir, ["rev-parse", "--show-superproject-working-tree"]) || null;
  }
  return false;
}

export function floorStatus(root) {
  return checkoutsUnder(root).map((checkout) => {
    const found = hookDir(checkout);
    if (!found) return { checkout, state: "not-a-repo" };
    const path = join(found.dir, "pre-push");
    if (found.outside) return { checkout, path, state: "elsewhere" };
    if (!existsSync(path)) return { checkout, path, state: "missing" };
    return { checkout, path, state: installedState(path, checkout) };
  });
}

/**
 * "It is kiln's file" was the whole test, so a hook written by an older version was left
 * in place forever — while its own first line says `Regenerate with kiln doctor --write`.
 * A remedy naming a command that does nothing is the shape this project keeps meeting, and
 * here it meant nobody who had already installed could receive a fix.
 */
function installedState(path, checkout) {
  const body = readFileSync(path, "utf8");
  if (!body.includes(MARKER)) return "foreign";
  if (body !== hookBody()) return "stale";
  return runnerReachable(checkout) ? "installed" : "no-runner";
}

/** Writes only what is missing, which is the same law `kiln init` follows for every file. */
export function installFloor(root) {
  const runner = runnerPath(root);
  mkdirSync(join(root, ".kiln", "hooks"), { recursive: true });
  if (!existsSync(runner)) writeFileSync(runner, runnerBody(), "utf8");

  const written = [];
  for (const row of floorStatus(root)) {
    if (row.state !== "missing" && row.state !== "stale") continue;
    mkdirSync(join(row.path, ".."), { recursive: true });
    writeFileSync(row.path, hookBody(), "utf8");
    chmodSync(row.path, 0o755);
    written.push(row.path);
  }
  return written;
}
