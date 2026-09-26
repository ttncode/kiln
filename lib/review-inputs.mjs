import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { checkoutsUnder } from "./guards/git-repo.mjs";
import { gitOutput } from "./init.mjs";
import { artifactPath } from "./state.mjs";

/**
 * D189: what the review's readers read, written once so every reader reads the same thing. BMAD
 * hands each lens a diff file rather than diff text ("a launch prompt never carries diff
 * text"), keeps the author's narrative in a separate claims file the edge-case hunter opens only
 * after tracing, and gives the intent auditor the intent itself. kiln's change is the working
 * tree against the base, untracked files included, and never kiln's own record under `.kiln/`.
 */

/**
 * D199: one diff per checkout. On a superproject whose code lives in submodules — the layout
 * kiln was first run against — the root's diff is a gitlink, `Subproject commit a → b`, and a
 * real run handed nine readers that instead of the change. Each submodule is diffed from the
 * commit the work's base recorded for it, with its own path as the prefix, the way `kiln scope`
 * already reaches inside (D45, `actualChanged`). What was dirty before the work opened is not
 * the change either, as `kiln scope` has always set it aside.
 */
function untrackedPatch(dir, { path, prefix }) {
  const args = ["diff", "--no-index", "--no-color", `--src-prefix=a/${prefix}`, `--dst-prefix=b/${prefix}`, "--", "/dev/null", path];
  try {
    return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    // `--no-index` exits 1 when the two sides differ, which for a new file they always do.
    return error.status === 1 ? error.stdout : "";
  }
}

function checkoutPatch(dir, { base, prefix, skip }) {
  const pathspec = ["--", ".", ...skip.map((path) => `:(exclude)${path}`)];
  const tracked = gitOutput(dir, ["diff", "--no-color", "--no-ext-diff", `--src-prefix=a/${prefix}`, `--dst-prefix=b/${prefix}`, base, ...pathspec]) ?? "";
  const untracked = (gitOutput(dir, ["ls-files", "--others", "--exclude-standard", ...pathspec]) ?? "").split("\n").filter(Boolean);
  return [tracked, ...untracked.map((path) => untrackedPatch(dir, { path, prefix }).trimEnd())].filter(Boolean);
}

/** The paths under `prefix`, relative to it: what a checkout at that prefix must leave out. */
function within(paths, prefix) {
  return paths.filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
}

function changePatch(root, state) {
  const modules = checkoutsUnder(root).slice(1).map((dir) => relative(root, dir));
  const before = state.dirty_at_open ?? [];
  const rootSkip = [".kiln", ...modules, ...before.filter((path) => !modules.some((module) => path.startsWith(`${module}/`)))];
  const parts = [...checkoutPatch(root, { base: state.base, prefix: "", skip: rootSkip })];
  for (const module of modules) {
    const base = gitOutput(root, ["rev-parse", `${state.base}:${module}`]);
    if (base) parts.push(...checkoutPatch(join(root, module), { base, prefix: `${module}/`, skip: within(before, `${module}/`) }));
  }
  return parts.join("\n");
}

function readIfPresent(path) {
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

function section(title, text) {
  return text ? `## ${title}\n\n${text}\n` : "";
}

function goalOf(plan) {
  return /^\*\*Goal:\*\*.*$/m.exec(plan)?.[0] ?? "";
}

export function writeReviewInputs(root, state) {
  const dir = join(root, ".kiln", "tmp", state.id, "review");
  mkdirSync(dir, { recursive: true });
  const plan = readIfPresent(artifactPath(root, { id: state.id, key: "plan" }));
  const brief = readIfPresent(join(root, ".kiln", "work", state.id, "brief.md"));
  const ledger = readIfPresent(join(root, ".kiln", "work", state.id, "ledger.md"));
  const paths = { diff: join(dir, "diff.patch"), claims: join(dir, "claims.md"), intent: join(dir, "intent.md") };
  writeFileSync(paths.diff, `${changePatch(root, state)}\n`);
  writeFileSync(paths.claims, [section("The plan", plan), section("The ledger", ledger)].join("\n") || "(no plan or ledger)\n");
  writeFileSync(paths.intent, [section("What was asked (the brief)", brief), section("The plan's goal", goalOf(plan))].join("\n") || "(no brief or plan)\n");
  return paths;
}
