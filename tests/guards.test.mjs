import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { PathError, isInside, pathEquals, resolveTarget, targetIsInside } from "../lib/paths.mjs";
import { protectedBranchViolation } from "../lib/guards/protected-branch.mjs";
import { dispatch } from "../hooks/dispatch.mjs";
import { cleanupFixtures, tempRoot, writeFile } from "./helpers/fixture.mjs";

after(cleanupFixtures);

const onMain = { protectedBranches: ["main", "v3-master"], currentBranch: "main" };
const onFeature = { protectedBranches: ["main", "v3-master"], currentBranch: "feat/export" };

const blocks = (command, context = onMain) => protectedBranchViolation({ command, ...context }) !== null;

test("A1: the seven write ops are blocked on a protected branch", () => {
  for (const op of ["push", "commit -m x", "merge other", "rebase other", "reset --hard HEAD~1", "revert HEAD", "cherry-pick abc"]) {
    assert.equal(blocks(`git ${op}`), true, `git ${op} was allowed`);
  }
});

test("A1: moving around and reading stay allowed", () => {
  for (const op of ["checkout -b feat/x", "pull", "fetch --all", "status", "log --oneline", "diff", "stash"]) {
    assert.equal(blocks(`git ${op}`), false, `git ${op} was blocked`);
  }
});

test("A1: a write op on an unprotected branch is not the guard's business", () => {
  assert.equal(blocks("git commit -m x", onFeature), false);
  assert.equal(blocks("git push", onFeature), false);
});

test("A1: `HEAD:v3-master` is caught even from a feature branch", () => {
  assert.equal(blocks("git push origin HEAD:v3-master", onFeature), true);
  assert.equal(blocks("git push origin HEAD:feat/other", onFeature), false);
});

test("A1: --force does not buy a way through", () => {
  assert.equal(blocks("git push --force origin HEAD:main", onFeature), true);
  assert.equal(blocks("git push -f", onMain), true);
});

test("A1: `-C <dir>` moves the repository, not the risk", () => {
  assert.equal(blocks("git -C /elsewhere push origin main", onFeature), true);
  assert.equal(blocks("git -c user.name=x -C /elsewhere commit -m y", onMain), true);
});

test("A1: a chained command is read segment by segment", () => {
  assert.equal(blocks("npm test && git push origin main", onFeature), true);
  assert.equal(blocks("git status; git commit -m x", onMain), true);
});

test("a refs/heads/ refspec is matched against the bare branch name", () => {
  assert.equal(blocks("git push origin HEAD:refs/heads/main", onFeature), true);
});

test("a command with no git in it never reaches the parser", () => {
  assert.equal(protectedBranchViolation({ command: "npm test", ...onMain }), null);
  assert.equal(protectedBranchViolation({ command: "", ...onMain }), null);
});

test("the violation names the branch and the subcommand, so the message can be specific", () => {
  const found = protectedBranchViolation({ command: "git push origin HEAD:v3-master", ...onFeature });
  assert.deepEqual(found, { subcommand: "push", branch: "v3-master" });
});

test("B29 / D52: a symlink leaf is rejected rather than followed", () => {
  const root = tempRoot();
  const secret = writeFile(join(root, "outside", "secrets"), "x");
  const link = join(root, "work", "link");
  mkdirSync(join(root, "work"), { recursive: true });
  symlinkSync(secret, link);

  assert.throws(() => resolveTarget(link, root), PathError);
  assert.equal(targetIsInside(join(root, "work"), { path: link, cwd: root }), false);
});

test("D52: a string prefix is not a boundary", () => {
  assert.equal(isInside("/home/you/repo", "/home/you/repo-evil/x"), false);
  assert.equal(isInside("/home/you/repo", "/home/you/repo/src/x"), true);
  assert.equal(isInside("/home/you/repo", "/home/you"), false);
});

test("D52: a leaf that does not exist yet still resolves, because a guard runs first", () => {
  const root = tempRoot();
  const target = resolveTarget(join(root, "src", "new-file.ts"), root);
  assert.match(target, /new-file\.ts$/);
  assert.equal(isInside(root, target), true);
});

test("D52: `..` cannot climb out of the sandbox", () => {
  const root = tempRoot();
  mkdirSync(join(root, "work"), { recursive: true });
  assert.equal(targetIsInside(join(root, "work"), { path: "../../escaped.txt", cwd: join(root, "work") }), false);
});

test("pathEquals compares segments, not strings", () => {
  assert.equal(pathEquals("/a/b/c", "/a/b/c"), true);
  assert.equal(pathEquals("/a/b/c", "/a/b/cc"), false);
});

test("D33: the dispatcher blocks through the chain, not just in the guard", () => {
  const payload = { tool_input: { command: "git push origin main" }, cwd: tempRoot() };
  assert.equal(dispatch("pre-bash", payload), 2);
});

test("D33: config missing falls back to a hardcoded list and still blocks", () => {
  const root = tempRoot();
  assert.equal(dispatch("pre-bash", { tool_input: { command: "git push origin master" }, cwd: root }), 2);
});

test("an unknown phase allows rather than inventing a chain", () => {
  assert.equal(dispatch("pre-nothing", {}), 0);
});

test("a Bash call with no git in it is allowed without spawning git", () => {
  assert.equal(dispatch("pre-bash", { tool_input: { command: "npm test" }, cwd: tempRoot() }), 0);
});

function runHook(phase, payload) {
  const dispatcher = new URL("../hooks/dispatch.mjs", import.meta.url).pathname;
  const result = spawnSync(process.execPath, [dispatcher, phase], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { code: result.status, stderr: result.stderr };
}

test("§1.6: the real hook contract — exit 2 plus stderr is what blocks", () => {
  const { code, stderr } = runHook("pre-bash", { tool_input: { command: "git push origin main" }, cwd: tempRoot() });
  assert.equal(code, 2, "a non-2 exit is a non-blocking error: the tool would run");
  assert.match(stderr, /protected branch/, "the block has to say why");
});

test("§1.6: an allowed command exits 0 through the real process", () => {
  assert.equal(runHook("pre-bash", { tool_input: { command: "npm test" }, cwd: tempRoot() }).code, 0);
});

test("D54: malformed stdin does not crash the dispatcher into failing open", () => {
  const dispatcher = new URL("../hooks/dispatch.mjs", import.meta.url).pathname;
  const result = spawnSync(process.execPath, [dispatcher, "pre-bash"], { input: "not json", encoding: "utf8" });
  assert.equal(result.status, 0, "nothing to protect in an empty payload, and it says so by allowing");
});

test("a malformed cwd still blocks, through the hardcoded fallback", () => {
  const { code, stderr } = runHook("pre-bash", { tool_input: { command: "git push origin main" }, cwd: "relative/nope" });
  assert.equal(code, 2, "config unreadable must never mean config absent");
  assert.match(stderr, /protected branch/);
});

test("D33 / D54: a guard that throws blocks, and names the recovery", () => {
  const { code, stderr } = runHook("pre-bash", { tool_input: { command: 12345 }, cwd: tempRoot() });
  assert.equal(code, 2, "a guard that cannot tell what the command is must not allow it");
  assert.match(stderr, /kiln doctor/, "the block has to name how to recover");
});
