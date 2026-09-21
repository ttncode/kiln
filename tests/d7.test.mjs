/**
 * The D7 list, as seven tests. This file is the promise and its proof in one place: if
 * you want to know what kiln actually enforces, read it here and nowhere else.
 *
 * Binary. One failure fails the build. Item 6 is a static check and says so.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatch } from "../hooks/dispatch.mjs";
import { protectedBranchViolation } from "../lib/guards/protected-branch.mjs";
import { isGreen, planSteps, runPhase } from "../lib/steps.mjs";
import { newWork, openNextPass, readState, recordVerify, writeState } from "../lib/state.mjs";
import { DEFAULTS } from "../lib/config.mjs";
import { cleanupFixtures, commitAll, initRepo, tempRoot, writeConfig, writeFile } from "./helpers/fixture.mjs";
import { kilnProject, payload } from "./helpers/project.mjs";

after(cleanupFixtures);

const BLOCK = 2;
const ALLOW = 0;
const edit = async (file, project, session) => dispatch("pre-edit", payload({ file, root: project.root, session }));
const bash = async (command, project) => dispatch("pre-bash", payload({ command, root: project.root }));

// ---------------------------------------------------------- 1. protected branch

test("D7 item 1 — kiln never pushes to a protected branch", async () => {
  const onFeature = { protectedBranches: ["main", "v3-master"], currentBranch: "feat/x" };
  const onMain = { protectedBranches: ["main"], currentBranch: "main" };

  assert.ok(protectedBranchViolation({ command: "git push", ...onMain }), "a bare push on main");
  assert.ok(protectedBranchViolation({ command: "git push --force origin HEAD:v3-master", ...onFeature }), "a forced refspec");
  assert.ok(protectedBranchViolation({ command: "git -C /elsewhere commit -m x", ...onMain }), "-C moves the repo, not the risk");
  assert.equal(protectedBranchViolation({ command: "git checkout -b feat/y", ...onMain }), null, "moving around stays allowed");
});

// ---------------------------------------------------------- 2. destroys data

test("D7 item 2 — kiln never destroys data unasked", async () => {
  const project = kilnProject({ gates: { plan: "approved" } });
  assert.equal(await bash("rm -rf /tmp/not-my-repo", project), BLOCK);
  assert.equal(await bash("git clean -xfd", project), ALLOW, "inside the repo is the user's own tree");
  assert.equal(await bash("rm -rf build", project), ALLOW);
});

// ---------------------------------------------------------- 3. failing test as passing

test("D7 item 3 — a failing step can never be reported as passing", async () => {
  const root = tempRoot();
  const ctx = { cwd: root, cmd: {}, tmpDir: join(root, "steps"), range: "aaa..bbb" };
  const liar = { id: "unit", run: "echo 'All tests passed' && exit 1" };

  const result = runPhase(planSteps([liar], { phase: "full" }), ctx);

  assert.equal(result.entries[0].exit, 1, "the verdict is the exit code, never the words");
  assert.match(result.entries[0].output, /All tests passed/, "the lie was printed and stored");
  assert.equal(isGreen(result, "full"), false);
  assert.equal(recordVerify(newWork({ id: "42", base: "a" }), result.entries[0]).verify[0].exit, 1);
});

test("D7 item 3 — a fast pass is never the project's green", async () => {
  const root = tempRoot();
  const ctx = { cwd: root, cmd: {}, tmpDir: join(root, "steps"), range: "aaa..bbb" };
  const result = runPhase(planSteps([{ id: "unit", run: "exit 0", phase: "fast" }], { phase: "fast" }), ctx);

  assert.equal(result.failed, null, "it passed");
  assert.equal(isGreen(result, "fast"), false, "and it still is not green — it ran only what changed");
});

// ---------------------------------------------------------- 4. skips a gate

test("D7 item 4 — no source edit without a gate record matching the current artifact", async () => {
  const before = kilnProject({ gates: {} });
  assert.equal(await edit(before.source, before), BLOCK, "no approval");

  const after = kilnProject({ gates: { plan: "approved" } });
  assert.equal(await edit(after.source, after), ALLOW, "approved");

  writeFileSync(after.artifacts.plan, "# quietly rewritten\n", "utf8");
  assert.equal(await edit(after.source, after), BLOCK, "the approval was for the document they read");
});

test("D7 item 4 — a halted work, and a new pass, both block", async () => {
  const halted = kilnProject({ gates: { plan: "approved" } });
  writeState(halted.root, { ...readState(halted.root, "42"), status: "halted" });
  assert.equal(await edit(halted.source, halted), BLOCK);

  const next = kilnProject({ gates: { plan: "approved" } });
  writeState(next.root, openNextPass(readState(next.root, "42"), "bbbb222"));
  assert.equal(await edit(next.source, next), BLOCK, "an unchanged artifact is the failure here, not the proof");
});

test("D7 item 4 — the shell is not a way around the gate", async () => {
  const project = kilnProject({ gates: {} });
  assert.equal(await bash('echo "x" > src/app.ts', project), BLOCK, "the measured first retry of a blocked agent");
  assert.equal(await bash("sed -i s/a/b/ src/app.ts", project), BLOCK);
});

// ---------------------------------------------------------- 5. writes outside the sandbox

test("D7 item 5 — kiln never writes outside its sandbox", async () => {
  const project = kilnProject({ gates: { plan: "approved" } });
  assert.equal(await edit("/tmp/somewhere-else.txt", project), BLOCK, "outside the root");
  assert.equal(await edit(join(project.root, ".kiln", "work", "99", "plan.md"), project), BLOCK, "another work's directory");
  assert.equal(await edit(project.source, project), ALLOW);
});

// ---------------------------------------------------------- 6. network egress (STATIC)

const SOURCE_DIRS = ["lib", "bin", "hooks"];
const BANNED = [/\bfetch\s*\(/, /node:https?\b/, /\bnode:net\b/, /\bnode:dgram\b/, /require\(['"]https?['"]\)/];
const ALLOWED_GIT_EGRESS = ["fetch", "ls-remote"];

function sourceFiles(dir, root) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, dir, entry.name);
    return entry.isDirectory() ? sourceFiles(join(dir, entry.name), root) : [path];
  });
}

test("D7 item 6 — STATIC: kiln's own code performs no network egress", async () => {
  const root = new URL("..", import.meta.url).pathname;
  for (const dir of SOURCE_DIRS) {
    for (const path of sourceFiles(dir, root)) {
      const text = readFileSync(path, "utf8");
      for (const pattern of BANNED) {
        assert.doesNotMatch(text, pattern, `${path} reaches the network`);
      }
    }
  }
});

test("D7 item 6 — STATIC: the two git verbs that do reach the network are allowlisted by name", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const calls = SOURCE_DIRS.flatMap((dir) => sourceFiles(dir, root))
    .flatMap((path) => [...readFileSync(path, "utf8").matchAll(/gitOutput\([^,]+,\s*\[\s*"([a-z-]+)"/g)].map((m) => m[1]));

  for (const verb of calls) {
    const reachesNetwork = ["fetch", "ls-remote", "push", "pull", "clone"].includes(verb);
    if (!reachesNetwork) continue;
    assert.ok(ALLOWED_GIT_EGRESS.includes(verb), `git ${verb} is egress and is not on the allowlist (D83)`);
  }
});

/**
 * Assembled rather than written out, because this file is itself scanned: spelling the
 * host literally here made the check fail on its own source. Local runs passed anyway —
 * `git ls-files` does not list a file that is not committed yet — so only CI saw it.
 */
const BRAND_HOST = ["primeradiant", "com"].join(".");

/**
 * Scoped to what ships. `docs/` records the decision to remove the hotlink and has to be
 * able to name it; a design note explaining a removal is the opposite of the problem.
 */
const SHIPPED = (relative) => !relative.startsWith("docs/");

test("D7 item 6 — STATIC: the upstream brand hotlink is absent from everything that ships (D11)", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const tracked = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  for (const relative of tracked.filter(SHIPPED)) {
    const path = join(root, relative);
    if (!statSync(path).isFile() || statSync(path).size > 2_000_000) continue;
    assert.equal(readFileSync(path, "utf8").includes(BRAND_HOST), false, `${relative} hotlinks a brand image`);
  }
});

// ---------------------------------------------------------- 7. approves its own gate

test("D7 item 7 — the agent cannot approve its own gate or disarm its own guards", async () => {
  const project = kilnProject({ gates: { plan: "approved" } });
  assert.equal(await edit(join(project.root, ".kiln", "work", "42", "state.json"), project), BLOCK);
  assert.equal(await edit(join(project.root, ".kiln", "config.json"), project), BLOCK);
  assert.equal(await edit(project.artifacts.plan, project), ALLOW, "artifacts precede every gate");
});

test("D7 item 7 — the control files stay closed in a session kiln does not drive", async () => {
  const project = kilnProject();
  assert.equal(await edit(join(project.root, ".kiln", "config.json"), project, "unrelated"), BLOCK);
});

/**
 * Item 3 is "never reports a failing test as passing", and the shape that defeated it on a
 * real project was not a lying test — it was a config with no steps at all. `kiln verify`
 * printed `green`, exit 0, having run nothing.
 */
test("D7 item 3: a phase with no steps refuses; it does not report green", () => {
  assert.equal(isGreen({ entries: [], failed: null }, "full"), false, "nothing ran, so nothing passed");

  const root = tempRoot("kiln-d7-nosteps-");
  initRepo(root);
  writeFile(join(root, "a.txt"), "a");
  commitAll(root, "first");
  writeConfig(root, { ...DEFAULTS, stack: { id: "node", cmd: { test: "true" }, steps: [] } });
  writeFile(join(root, ".kiln", "rules", "index.md"), "# rules\n");

  const bin = new URL("../bin/kiln.mjs", import.meta.url).pathname;
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8" });
  cli("open", "w1");

  const run = cli("verify", "w1");
  assert.equal(run.status, 1, `verify exited ${run.status}: ${run.stdout}${run.stderr}`);
  assert.match(run.stderr, /no .* step/);
  assert.doesNotMatch(run.stdout, /green/);
});
