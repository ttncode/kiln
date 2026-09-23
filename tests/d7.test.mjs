/**
 * The D7 list, as seven tests. This file is the promise and its proof in one place: if
 * you want to know what kiln actually enforces, read it here and nowhere else.
 *
 * Binary. One failure fails the build. Item 6 is a static check and says so.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatch } from "../hooks/dispatch.mjs";
import { gitOutput } from "../lib/init.mjs";
import { mintId } from "../lib/resolve.mjs";
import { protectedBranchViolation } from "../lib/guards/protected-branch.mjs";
import { isGreen, planSteps, runPhase } from "../lib/steps.mjs";
import { newWork, readState, recordVerify, writeState } from "../lib/state.mjs";
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

/**
 * The spellings that were ALLOWED on a real repository while standing on a protected
 * branch. Every one is a name git resolves and the scan compared as text — so the fix is
 * to ask git, not to add another pattern. `resolveRef` stands in for that here; the real
 * one is `git rev-parse --abbrev-ref`, exercised against a real repository below.
 */
test("D7 item 1 — a ref git resolves is not a string kiln may compare", () => {
  const onMain = {
    protectedBranches: ["main"],
    currentBranch: "main",
    resolveRef: (spec) => (["HEAD", "@"].includes(spec) ? "main" : spec),
  };
  for (const command of [
    "git push origin HEAD",
    "git push origin @",
    "git push -u origin HEAD",
    "git push --force origin HEAD",
    "git push origin +main",
    "git push origin",
  ]) {
    assert.ok(protectedBranchViolation({ command, ...onMain }), `ALLOWED: ${command}`);
  }

  const onFeature = { ...onMain, currentBranch: "feat/x", resolveRef: (spec) => (spec === "HEAD" ? "feat/x" : spec) };
  assert.equal(protectedBranchViolation({ command: "git push origin HEAD", ...onFeature }), null, "a feature branch still pushes");
  assert.equal(protectedBranchViolation({ command: "git push origin feat/x", ...onFeature }), null);
});

test("D7 item 1 — the real resolver answers from a real repository", () => {
  const root = tempRoot("kiln-d7-refspec-");
  initRepo(root);
  writeFile(join(root, "a.txt"), "a");
  commitAll(root, "first");
  const resolveRef = (spec) => gitOutput(root, ["rev-parse", "--abbrev-ref", spec]);

  assert.equal(resolveRef("HEAD"), "main");
  assert.equal(resolveRef("@"), "main");
  assert.ok(protectedBranchViolation({ command: "git push origin HEAD", protectedBranches: ["main"], currentBranch: "main", resolveRef }));
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

test("D7 item 4 — a halted work, a reviewed one, and an approval with no document all block", async () => {
  const halted = kilnProject({ gates: { plan: "approved" } });
  writeState(halted.root, { ...readState(halted.root, "42"), status: "halted" });
  assert.equal(await edit(halted.source, halted), BLOCK);

  const reviewed = kilnProject({ gates: { plan: "approved", review: "approved" } });
  writeState(reviewed.root, { ...readState(reviewed.root, "42"), status: "reviewed" });
  assert.equal(await edit(reviewed.source, reviewed), BLOCK, "a change after review would ship unreviewed");

  const unbound = kilnProject({ gates: { plan: "approved" } });
  const state = readState(unbound.root, "42");
  writeState(unbound.root, { ...state, gates: { plan: { ...state.gates.plan, artifact_sha: null } } });
  assert.equal(await edit(unbound.source, unbound), BLOCK, "an approval bound to nothing authorizes nothing");
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

/**
 * Item 7's words are "the agent cannot change the terms it is judged by", and a project
 * rule became such a term the moment `kiln rules` started handing one to a stage. An agent
 * that finds a rule inconvenient must not be able to answer it by rewriting the rule.
 */
test("D7 item 7 — a run may not rewrite the project rules it is judged by", async () => {
  const project = kilnProject({ gates: { plan: "approved" } });
  assert.equal(await edit(join(project.root, ".kiln", "rules", "auth.md"), project), BLOCK);
  assert.equal(await edit(join(project.root, ".kiln", "rules", "auth.md"), project, "unrelated"), ALLOW, "outside a run nothing is being judged");
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
  assert.equal(
    isGreen({ entries: [{ id: "unit", skipped: "requires migrate" }], failed: null }, "full"),
    false,
    "a skipped step is an entry, and an entry is not evidence",
  );
  assert.equal(isGreen({ entries: [{ id: "unit", exit: 0 }], failed: null }, "full"), true);

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
  assert.match(run.stderr, /stack.steps is empty/, "and here it really is empty");
});

/**
 * The refusal said `"steps" is empty` for a config holding one step in another phase, and
 * pointed at `kiln init` "in a project kiln has not configured yet" — on a project init had
 * configured minutes earlier. A message naming a remedy that does not exist is the shape
 * this project keeps re-meeting, so the phase it actually has is what it now reports.
 */
test("a phase with no steps says which steps there are, and a remedy that works", () => {
  const root = tempRoot("kiln-emptyphase-");
  initRepo(root);
  writeFile(join(root, "a.txt"), "a");
  commitAll(root, "first");
  writeConfig(root, {
    ...DEFAULTS,
    stack: { id: "node", cmd: { test: "true" }, steps: [{ id: "unit", run: "${cmd.test}" }] },
  });
  writeFile(join(root, ".kiln", "rules", "index.md"), "# rules\n");

  const bin = new URL("../bin/kiln.mjs", import.meta.url).pathname;
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8" });
  cli("open", "w1");

  const run = cli("verify", "w1", "--phase", "fast");
  assert.equal(run.status, 1);
  assert.doesNotMatch(run.stderr, /"steps" is empty/, "it is not empty; it holds one full step");
  assert.match(run.stderr, /stack.steps holds 1, none of them fast/);
  assert.match(run.stderr, /unit — phase full/);
  assert.match(run.stderr, /kiln config set stack\.cmd\.test_fast=/, "the verb that changes a written config");
  assert.doesNotMatch(run.stderr, /kiln init/, "init overwrites nothing, so it is no remedy here");
});

/**
 * Item 7 is not "config.json is hard to edit" — it is that the agent cannot change the
 * terms it is judged by. Deleting the file is a stronger edit than writing it, and on a
 * real run `rm -f .kiln/config.json` was allowed: `rm` reached the sandbox only through
 * the `rm -rf` pattern, which needs both flags.
 */
test("D7 item 7: a control file cannot be removed or emptied through the shell", async () => {
  const { root } = kilnProject({ gates: { plan: "approved" } });
  for (const command of [
    "rm -f .kiln/config.json",
    "rm .kiln/config.json",
    "rm -rf .kiln/config.json",
    "truncate -s 0 .kiln/config.json",
    "unlink .kiln/work/42/state.json",
    `node -e "require('fs').writeFileSync('.kiln/config.json','{}')"`,
    `python3 -c "open('.kiln/config.json','w').write('{}')"`,
  ]) {
    assert.equal(await dispatch("pre-bash", payload({ command, root })), 2, `ALLOWED: ${command}`);
  }
});

test("removal stays narrow: an ordinary file is still the harness's call", async () => {
  const { root } = kilnProject({ gates: { plan: "approved" } });
  assert.equal(await dispatch("pre-bash", payload({ command: "rm -f build/out.log", root })), 0);
});

/**
 * Git's own hooks see a command after git has resolved directory, branch and config — the
 * runtime classes no scan of a command line reaches. Measured with a failing hook
 * installed, every line below let the operation through, and kiln guarded none of them.
 */
test("D7 item 7 — verification cannot be switched off from inside the run", async () => {
  const { root } = kilnProject({ gates: { plan: "approved" } });
  for (const command of [
    "git push --no-verify origin feat/x",
    "git commit --no-verify -m x",
    "git commit -n -m x",
    "git -c core.hooksPath=/dev/null push origin feat/x",
    "git config core.hooksPath /dev/null",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git push origin feat/x",
    "rm -f .git/hooks/pre-push",
    "echo x > .git/hooks/pre-push",
  ]) {
    assert.equal(await bash(command, { root }), BLOCK, `ALLOWED: ${command}`);
  }
});

test("the disarm matcher reads flags, not words: -n is --dry-run for push, and a message is not a flag", async () => {
  const { root } = kilnProject({ gates: { plan: "approved" } });
  assert.equal(await bash("git push -n origin feat/x", { root }), ALLOW, "-n is --dry-run here, and the hook still runs");
  assert.equal(await bash("git commit -m 'no verify needed'", { root }), ALLOW, "the words are not the flag");
});


/**
 * Measured on a real run. The only full-phase step was `unit` with `requires: ["migrate"]`,
 * the change produced no migration, and kiln printed:
 *
 *     skip  unit — requires migrate
 *     green
 *
 * Nothing executed and no test lied. The earlier guard asked whether there were entries;
 * a skipped step is one.
 */
test("D7 item 3: every step skipped is not a pass", () => {
  const root = tempRoot("kiln-d7-allskipped-");
  initRepo(root);
  writeFile(join(root, "a.txt"), "a");
  commitAll(root, "first");
  writeConfig(root, {
    ...DEFAULTS,
    stack: {
      id: "node",
      cmd: { test: "true" },
      steps: [{ id: "unit", run: "${cmd.test}", requires: ["migrate"] }],
    },
  });
  writeFile(join(root, ".kiln", "rules", "index.md"), "# rules\n");

  const bin = new URL("../bin/kiln.mjs", import.meta.url).pathname;
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8" });
  cli("open", "w1");

  const skipped = cli("verify", "w1");
  assert.equal(skipped.status, 1, `verify exited ${skipped.status}: ${skipped.stdout}${skipped.stderr}`);
  assert.doesNotMatch(skipped.stdout, /green/);
  assert.match(skipped.stderr, /every step was skipped/);
  assert.match(skipped.stderr, /unit — requires migrate/, "the reason is the fix");

  const ran = cli("verify", "w1", "--effects", "migrate");
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /green/);
});

/**
 * Item 5 is "never writes outside its sandbox", and kiln's own CLI did. A work id becomes a
 * directory name, so it is a path, and nothing checked it as one:
 *
 *     kiln open '../../../escaped'   →   <outside the project>/state.json
 *     kiln open '../escaped'         →   .kiln/escaped/  — where listWork cannot see it
 *
 * The likelier one was quieter: an agent minted `#1586` from a ticket and every command
 * touching that work had to remember to quote it, because `#` starts a shell comment.
 * `mintId` would have produced `20260922-1586`; nothing made the id kiln *accepts* the same
 * as the id kiln *mints*.
 */
test("D7 item 5: a work id is one path segment, not a path", () => {
  const root = tempRoot("kiln-d7-id-");
  initRepo(root);
  writeFile(join(root, "a.txt"), "a");
  commitAll(root, "first");
  writeConfig(root, { ...DEFAULTS, stack: { id: "node", cmd: { test: "true" }, steps: [{ id: "unit", run: "${cmd.test}" }] } });
  writeFile(join(root, ".kiln", "rules", "index.md"), "# rules\n");

  const bin = new URL("../bin/kiln.mjs", import.meta.url).pathname;
  const open = (id) => spawnSync(process.execPath, [bin, "open", id], { cwd: root, encoding: "utf8" });

  for (const id of ["../../../escaped", "../escaped", "sub/dir", "#1586", "a b", "-rf", ".", ""]) {
    const run = open(id);
    assert.notEqual(run.status, 0, `accepted as an id: ${JSON.stringify(id)}`);
    assert.match(`${run.stdout}${run.stderr}`, /work id|needs an id/);
  }
  assert.equal(existsSync(join(root, "..", "escaped")), false, "nothing reached outside the project");
  assert.equal(existsSync(join(root, ".kiln", "escaped")), false, "nor outside .kiln/work/");

  assert.equal(open(mintId({ text: "the export button does nothing", now: new Date("2026-09-22") })).status, 0, "what kiln mints, kiln accepts");
});

/**
 * The id check from the test above threw on a directory an older kiln had happily created,
 * and that killed `kiln list`, `kiln doctor`, and — through `activeWorks` — every guarded
 * call in the session. Which is exactly the deadlock #63 closed, walked back in through the
 * door its own fix opened.
 *
 * Only *addressing* a work checks its id. Finding one that cannot be addressed is a report.
 */
test("a directory kiln cannot address is reported, not a reason to stop", async () => {
  const { root } = kilnProject({ gates: { plan: "approved" } });
  mkdirSync(join(root, ".kiln", "work", "#1586"), { recursive: true });
  writeFileSync(join(root, ".kiln", "work", "#1586", "state.json"), JSON.stringify({ id: "#1586", status: "in_progress" }), "utf8");

  assert.equal(await dispatch("pre-bash", payload({ command: "npm test", root })), ALLOW, "one bad directory does not stop the session");

  const bin = new URL("../bin/kiln.mjs", import.meta.url).pathname;
  const list = spawnSync(process.execPath, [bin, "list"], { cwd: root, encoding: "utf8" });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /#1586\s+invalid/);

  const doctor = spawnSync(process.execPath, [bin, "doctor"], { cwd: root, encoding: "utf8" });
  const line = doctor.stdout.split("\n").find((row) => row.includes("cannot be a work id"));
  assert.ok(line, doctor.stdout);
  assert.match(line, /\[warn\]/, "a warning, not a stop");
  assert.match(line, /rename or delete it/);
});
