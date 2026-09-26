import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitOutput } from "./init.mjs";
import { artifactPath } from "./state.mjs";

/**
 * D189: what the review's readers read, written once so every reader reads the same thing. BMAD
 * hands each lens a diff file rather than diff text ("a launch prompt never carries diff
 * text"), keeps the author's narrative in a separate claims file the edge-case hunter opens only
 * after tracing, and gives the intent auditor the intent itself. kiln's change is the working
 * tree against the base, untracked files included, and never kiln's own record under `.kiln/`.
 */

const NOT_KILN = ":(exclude).kiln";

function untrackedPatch(root, path) {
  try {
    return execFileSync("git", ["diff", "--no-index", "--no-color", "--", "/dev/null", path], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    // `--no-index` exits 1 when the two sides differ, which for a new file they always do.
    return error.status === 1 ? error.stdout : "";
  }
}

function changePatch(root, base) {
  const tracked = gitOutput(root, ["diff", "--no-color", "--no-ext-diff", base, "--", ".", NOT_KILN]) ?? "";
  const untracked = (gitOutput(root, ["ls-files", "--others", "--exclude-standard", "--", ".", NOT_KILN]) ?? "").split("\n").filter(Boolean);
  return [tracked, ...untracked.map((path) => untrackedPatch(root, path).trimEnd())].filter(Boolean).join("\n");
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
  writeFileSync(paths.diff, `${changePatch(root, state.base)}\n`);
  writeFileSync(paths.claims, [section("The plan", plan), section("The ledger", ledger)].join("\n") || "(no plan or ledger)\n");
  writeFileSync(paths.intent, [section("What was asked (the brief)", brief), section("The plan's goal", goalOf(plan))].join("\n") || "(no brief or plan)\n");
  return paths;
}
