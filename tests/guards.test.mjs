import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { PathError, isInside, pathEquals, resolveTarget, targetIsInside } from "../lib/paths.mjs";
import { protectedBranchViolation } from "../lib/guards/protected-branch.mjs";
import { dispatch } from "../hooks/dispatch.mjs";
import { DEFAULTS } from "../lib/config.mjs";
import { cleanupFixtures, tempRoot, writeConfig, writeFile } from "./helpers/fixture.mjs";

after(cleanupFixtures);

const onMain = { protectedBranches: ["main", "v3-master"], currentBranch: "main" };
const onFeature = { protectedBranches: ["main", "v3-master"], currentBranch: "feat/export" };

const blocks = (command, context = onMain) => protectedBranchViolation({ command, ...context }) !== null;

test("A1: the seven write ops are blocked on a protected branch", async () => {
  for (const op of ["push", "commit -m x", "merge other", "rebase other", "reset --hard HEAD~1", "revert HEAD", "cherry-pick abc"]) {
    assert.equal(blocks(`git ${op}`), true, `git ${op} was allowed`);
  }
});

test("A1: moving around and reading stay allowed", async () => {
  for (const op of ["checkout -b feat/x", "pull", "fetch --all", "status", "log --oneline", "diff", "stash"]) {
    assert.equal(blocks(`git ${op}`), false, `git ${op} was blocked`);
  }
});

test("A1: a write op on an unprotected branch is not the guard's business", async () => {
  assert.equal(blocks("git commit -m x", onFeature), false);
  assert.equal(blocks("git push", onFeature), false);
});

test("A1: `HEAD:v3-master` is caught even from a feature branch", async () => {
  assert.equal(blocks("git push origin HEAD:v3-master", onFeature), true);
  assert.equal(blocks("git push origin HEAD:feat/other", onFeature), false);
});

test("A1: --force does not buy a way through", async () => {
  assert.equal(blocks("git push --force origin HEAD:main", onFeature), true);
  assert.equal(blocks("git push -f", onMain), true);
});

test("A1: `-C <dir>` moves the repository, not the risk", async () => {
  assert.equal(blocks("git -C /elsewhere push origin main", onFeature), true);
  assert.equal(blocks("git -c user.name=x -C /elsewhere commit -m y", onMain), true);
});

test("A1: a chained command is read segment by segment", async () => {
  assert.equal(blocks("npm test && git push origin main", onFeature), true);
  assert.equal(blocks("git status; git commit -m x", onMain), true);
});

test("a refs/heads/ refspec is matched against the bare branch name", async () => {
  assert.equal(blocks("git push origin HEAD:refs/heads/main", onFeature), true);
});

test("a command with no git in it never reaches the parser", async () => {
  assert.equal(protectedBranchViolation({ command: "npm test", ...onMain }), null);
  assert.equal(protectedBranchViolation({ command: "", ...onMain }), null);
});

test("the violation names the branch and the subcommand, so the message can be specific", async () => {
  const found = protectedBranchViolation({ command: "git push origin HEAD:v3-master", ...onFeature });
  assert.deepEqual(found, { subcommand: "push", branch: "v3-master" });
});

test("B29 / D52: a symlink leaf is rejected rather than followed", async () => {
  const root = tempRoot();
  const secret = writeFile(join(root, "outside", "secrets"), "x");
  const link = join(root, "work", "link");
  mkdirSync(join(root, "work"), { recursive: true });
  symlinkSync(secret, link);

  assert.throws(() => resolveTarget(link, root), PathError);
  assert.equal(targetIsInside(join(root, "work"), { path: link, cwd: root }), false);
});

test("D52: a string prefix is not a boundary", async () => {
  assert.equal(isInside("/home/you/repo", "/home/you/repo-evil/x"), false);
  assert.equal(isInside("/home/you/repo", "/home/you/repo/src/x"), true);
  assert.equal(isInside("/home/you/repo", "/home/you"), false);
});

test("D52: a leaf that does not exist yet still resolves, because a guard runs first", async () => {
  const root = tempRoot();
  const target = resolveTarget(join(root, "src", "new-file.ts"), root);
  assert.equal(target, join(root, "src", "new-file.ts"), "the tail is kept, not collapsed to the leaf");
  assert.equal(isInside(root, target), true);
});

test("D52: a deep path whose directories do not exist keeps every segment", async () => {
  const root = tempRoot();
  const deep = join(root, "application", "migrations", "001_drop.php");

  assert.equal(resolveTarget(deep, root), deep, "collapsing it makes every path-shape guard read the wrong shape");
});

test("D52: `..` is normalised before anything looks at the path", async () => {
  const root = tempRoot();
  assert.equal(resolveTarget(join(root, "src", "..", "a.ts"), root), join(root, "a.ts"));
});

test("D52: `..` cannot climb out of the sandbox", async () => {
  const root = tempRoot();
  mkdirSync(join(root, "work"), { recursive: true });
  assert.equal(targetIsInside(join(root, "work"), { path: "../../escaped.txt", cwd: join(root, "work") }), false);
});

test("pathEquals compares segments, not strings", async () => {
  assert.equal(pathEquals("/a/b/c", "/a/b/c"), true);
  assert.equal(pathEquals("/a/b/c", "/a/b/cc"), false);
});

/** A project kiln drives: a config, and nothing else. */
function kilnRoot() {
  const root = tempRoot();
  writeConfig(root, DEFAULTS);
  return root;
}

test("D33: the dispatcher blocks through the chain, not just in the guard", async () => {
  const payload = { tool_input: { command: "git push origin main" }, cwd: kilnRoot() };
  assert.equal(await dispatch("pre-bash", payload), 2);
});

test("D33: a config that cannot be read falls back to a hardcoded list and still blocks", async () => {
  const root = kilnRoot();
  writeFile(join(root, ".kiln", "config.json"), "{ not json");
  assert.equal(await dispatch("pre-bash", { tool_input: { command: "git push origin master" }, cwd: root }), 2);
});

/**
 * D148. Installing the plugin once made kiln refuse `git push origin main` in every
 * repository on the machine, through the same fallback — including projects that never ran
 * `kiln init`. A project kiln does not drive is D33's proven branch: nothing to protect.
 */
test("D148: where no project kiln drives is touched, nothing is judged", async () => {
  const plain = tempRoot();
  assert.equal(await dispatch("pre-bash", { tool_input: { command: "git push origin main" }, cwd: plain }), 0);
  assert.equal(await dispatch("pre-bash", { tool_input: { command: "git commit -n -m x" }, cwd: plain }), 0);
  assert.equal(await dispatch("pre-edit", { tool_input: { file_path: join(plain, "anything.js") }, cwd: plain }), 0);
});

test("D148: a call that reaches into a kiln project from outside it is judged by that project", async () => {
  const project = kilnRoot();
  const outside = tempRoot();
  const from = (command) => dispatch("pre-bash", { tool_input: { command }, cwd: outside });
  assert.equal(await from(`git -C ${project} push origin main`), 2);
  assert.equal(await from(`cd ${project} && git commit -n -m x`), 2);
  assert.equal(await from(`echo {} > ${join(project, ".kiln", "config.json")}`), 2);
  assert.equal(await dispatch("pre-edit", { tool_input: { file_path: join(project, ".kiln", "config.json") }, cwd: outside }), 2);
});

test("an unknown phase allows rather than inventing a chain", async () => {
  assert.equal(await dispatch("pre-nothing", {}), 0);
});

test("a Bash call with no git in it is allowed without spawning git", async () => {
  assert.equal(await dispatch("pre-bash", { tool_input: { command: "npm test" }, cwd: tempRoot() }), 0);
});

function runHook(phase, payload) {
  const dispatcher = new URL("../hooks/dispatch.mjs", import.meta.url).pathname;
  const result = spawnSync(process.execPath, [dispatcher, phase], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { code: result.status, stderr: result.stderr };
}

test("§1.6: the real hook contract — exit 2 plus stderr is what blocks", async () => {
  const { code, stderr } = runHook("pre-bash", { tool_input: { command: "git push origin main" }, cwd: kilnRoot() });
  assert.equal(code, 2, "a non-2 exit is a non-blocking error: the tool would run");
  assert.match(stderr, /protected branch/, "the block has to say why");
});

test("§1.6: an allowed command exits 0 through the real process", async () => {
  assert.equal(runHook("pre-bash", { tool_input: { command: "npm test" }, cwd: tempRoot() }).code, 0);
});

test("D54: malformed stdin does not crash the dispatcher into failing open", async () => {
  const dispatcher = new URL("../hooks/dispatch.mjs", import.meta.url).pathname;
  const result = spawnSync(process.execPath, [dispatcher, "pre-bash"], { input: "not json", encoding: "utf8" });
  assert.equal(result.status, 0, "nothing to protect in an empty payload, and it says so by allowing");
});

test("a malformed cwd does not hide a kiln project the command names", async () => {
  const { code, stderr } = runHook("pre-bash", { tool_input: { command: `git -C ${kilnRoot()} push origin main` }, cwd: "relative/nope" });
  assert.equal(code, 2);
  assert.match(stderr, /protected branch/);
});

test("D33 / D54: a guard that throws blocks, and names the recovery", async () => {
  const { code, stderr } = runHook("pre-bash", { tool_input: { command: 12345 }, cwd: kilnRoot() });
  assert.equal(code, 2, "a guard that cannot tell what the command is must not allow it");
  assert.match(stderr, /kiln doctor/, "the block has to name how to recover");
});
