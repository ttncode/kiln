/**
 * kiln as a real user meets it.
 *
 * The rest of the suite tests mechanisms one at a time, and a week of fixes proved that is
 * not where the defects were: every one was found by running the product. These are
 * journeys instead — what a person does, in the order they do it — and the last group
 * crosses features that were fixed separately, because two right fixes can describe two
 * different runs.
 *
 * The matrix these rows come from is docs/design/2026-09-22-journey-matrix.md.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ALLOW, BLOCK } from "./helpers/verdict.mjs";
import { SESSION, bash, config, edit, kiln, monorepo, nodeProject, ok, state, throughPlanGate, writeReview } from "./helpers/journey.mjs";
import { spawnSync } from "node:child_process";
import { cleanupFixtures, commitAll, git, initRepo, tempRoot, writeFile } from "./helpers/fixture.mjs";

after(cleanupFixtures);

// ─────────────────────────────────────────────── J1 · the first ten minutes

test("J1.1 init on a Node project writes a config and names what it decided", () => {
  const root = initRepo(tempRoot("kiln-j11-"));
  writeFile(join(root, "package.json"), JSON.stringify({ name: "app", scripts: { test: "vitest run" } }));
  commitAll(root, "first");

  const run = ok(root, ["init"]);
  assert.match(run.stdout, /stack: node \(package\.json\)/);
  assert.match(run.stdout, /kiln decided these for you/);
  assert.ok(existsSync(join(root, ".kiln", "config.json")));
  assert.ok(existsSync(join(root, ".kiln", "rules", "index.md")));
  assert.ok(existsSync(join(root, ".git", "hooks", "pre-push")), "the floor is installed at init");
});

test("J1.2 init finishes on a project kiln cannot identify", () => {
  const root = initRepo(tempRoot("kiln-j12-"));
  const run = ok(root, ["init"]);
  assert.match(run.stdout, /stack: unknown/);
  assert.equal(config(root).stack.id, "unknown", "the user names it; init does not guess");
});

test("J1.3 init a second time overwrites nothing", () => {
  const root = nodeProject({ name: "j13" });
  const before = readFileSync(join(root, ".kiln", "config.json"), "utf8");
  const run = ok(root, ["init"]);

  assert.match(run.stdout, /kept/);
  assert.equal(readFileSync(join(root, ".kiln", "config.json"), "utf8"), before);
});

test("J1.4 doctor calls a project init set up Ready, with nothing warned about", () => {
  const root = initRepo(tempRoot("kiln-j14-"));
  writeFile(join(root, "package.json"), JSON.stringify({ name: "app", scripts: { test: "true" } }));
  commitAll(root, "first");
  ok(root, ["init"]);

  const run = ok(root, ["doctor"]);
  assert.match(run.stdout, /^Ready\.$/m, "what init writes, doctor accepts without a warning");
  assert.doesNotMatch(run.stdout, /FAIL/);
});

test("J1.5 init --help writes nothing", () => {
  const root = initRepo(tempRoot("kiln-j15-"));
  ok(root, ["init", "--help"]);
  assert.equal(existsSync(join(root, ".kiln")), false);
});

// ─────────────────────────────────────────────── J2 · a bounded change

test("J2.1 a bounded change runs stage by stage and ships as one repository", async () => {
  const root = nodeProject({ name: "j21" });
  throughPlanGate(root, "w1");

  assert.equal(await edit(root, "src/app.js"), ALLOW, "the plan gate authorises source edits");
  writeFile(join(root, "src", "app.js"), "export const a = 2;\n");

  const scope = ok(root, ["scope", "w1"]);
  assert.match(scope.stdout, /predicted 1 · actual 1/);

  writeReview(root, "w1");
  ok(root, ["gate", "w1", "review", "--artifact", ".kiln/work/w1/review.md", "--answer", "approve"]);
  ok(root, ["verify", "w1"]);

  const ship = ok(root, ["ship", "w1"]);
  assert.match(ship.stdout, /Ship — 1 repository/);
  assert.doesNotMatch(ship.stdout, /do not merge atomically/, "one repository needs no warning about several");
});

test("J2.2 a source edit before the plan gate is blocked, redirect included", async () => {
  const root = nodeProject({ name: "j22" });
  ok(root, ["open", "w1", "--session", SESSION]);

  assert.equal(await edit(root, "src/app.js"), BLOCK);
  assert.equal(await bash(root, "echo x > src/app.js"), BLOCK);
  assert.equal(await bash(root, "sed -i 's/a/b/' src/app.js"), BLOCK);
  assert.equal(await bash(root, "cp /etc/hostname src/app.js"), BLOCK);
});

test("J2.3 changing the artifact after approval revokes it", async () => {
  const root = nodeProject({ name: "j23" });
  throughPlanGate(root, "w1");
  assert.equal(await edit(root, "src/app.js"), ALLOW);

  writeFile(join(root, ".kiln", "work", "w1", "plan.md"), "# plan, rewritten\n");
  assert.equal(await edit(root, "src/app.js"), BLOCK, "approval binds to the document that was read");
});

test("J2.4 opening a pull request before the review gate is blocked", async () => {
  const root = nodeProject({ name: "j24" });
  throughPlanGate(root, "w1");
  assert.equal(await bash(root, "gh pr create --fill"), BLOCK);

  writeReview(root, "w1");
  ok(root, ["gate", "w1", "review", "--artifact", ".kiln/work/w1/review.md", "--answer", "approve"]);
  assert.equal(await bash(root, "gh pr create --fill"), ALLOW);
});

// ─────────────────────────────────────────────── J3 · how the answer is given

test("J3 the gate reads what the user said, not how they clicked", () => {
  const root = nodeProject({ name: "j3" });
  ok(root, ["open", "w1", "--session", SESSION]);
  writeFile(join(root, ".kiln", "work", "w1", "plan.md"), "# plan\n\n## Risk flags\n- none\n");
  const answer = (text) => kiln(root, ["gate", "w1", "plan", "--artifact", ".kiln/work/w1/plan.md", "--answer", text]);

  assert.equal(answer("1").status, 2, "J3.3 a bare number is a click");
  assert.match(answer("1").stdout, /"recorded": false/);
  assert.equal(answer("sounds good").status, 2, "J3.5");
  assert.match(answer("sounds good").stdout, /Pick one/, "the re-ask offers two concrete options");
  const stopped = answer("3. Stop here, keep the artifacts");
  assert.equal(stopped.status, 2, "J3.6 a rejection is recorded, and is not a gate that opened");
  assert.equal(state(root, "w1").gates.plan.decision, "rejected", "the no is kept as evidence");

  assert.equal(answer("1. Approve this plan as written").status, 0, "J3.2");
  assert.equal(state(root, "w1").gates.plan.answer, "1. Approve this plan as written", "verbatim");
  assert.equal(answer("Approve -> no need to run the suite -> ship locally").status, 0, "J3.4");
  assert.equal(answer("approve").status, 0, "J3.1");
});

// ─────────────────────────────────────────────── J4 · paths and the ratchet

test("J4.1 a spike cannot ship", async () => {
  const root = nodeProject({ name: "j41" });
  ok(root, ["open", "w1", "--path", "spike", "--session", SESSION]);
  assert.equal(await bash(root, "gh pr create --fill"), BLOCK, "no gate on this path authorises it");
});

test("J4.2 a path word in the request opens that path and leaves the id alone", () => {
  const root = nodeProject({ name: "j42" });
  const resolved = JSON.parse(ok(root, ["resolve", "full The export button does nothing"]).stdout);

  assert.equal(resolved.path, "full");
  assert.doesNotMatch(resolved.id, /full/, "the word is an instruction, not a subject");
  ok(root, ["open", resolved.id, "--path", resolved.path, "--session", SESSION]);
  assert.equal(state(root, resolved.id).path, "full");
});

test("J4.3/J4.4/J4.5 the ratchet is free until something is recorded", () => {
  const root = nodeProject({ name: "j43" });
  ok(root, ["open", "w1", "--path", "bounded", "--session", SESSION]);

  assert.equal(kiln(root, ["ratchet", "w1", "spike"]).status, 0, "J4.5 nothing recorded, nothing to launder");
  assert.equal(kiln(root, ["ratchet", "w1", "full"]).status, 0, "J4.3");

  writeFile(join(root, ".kiln", "work", "w1", "spec.md"), "# spec\n");
  ok(root, ["gate", "w1", "spec", "--artifact", ".kiln/work/w1/spec.md", "--answer", "approve"]);

  const down = kiln(root, ["ratchet", "w1", "bounded"]);
  assert.equal(down.status, 1, "J4.4");
  assert.match(down.stderr, /only goes up/);
});

// ─────────────────────────────────────────────── J5 · auto mode

test("J5 auto rules only what it is allowed to, and says so before it does", () => {
  const request = nodeProject({ name: "j51" });
  const opened = ok(request, ["open", "w1", "--path", "bounded", "--session", SESSION, "--auto"]);
  assert.match(opened.stdout, /auto mode is ON for bounded \(the --auto in your request\)/, "J5.1");
  assert.equal(config(request).auto.bounded, false, "a run's flag never writes the standing default");

  const standing = nodeProject({ name: "j52", auto: { bounded: true } });
  assert.match(ok(standing, ["open", "w1", "--path", "bounded"]).stdout, /ON for bounded \(auto.bounded\)/, "J5.2");

  const spike = nodeProject({ name: "j53" });
  ok(spike, ["open", "w1", "--path", "spike", "--session", SESSION, "--auto"]);
  writeFile(join(spike, ".kiln", "work", "w1", "brief.md"), "# brief\n");
  const ruled = kiln(spike, ["gate", "w1", "probe", "--artifact", ".kiln/work/w1/brief.md", "--auto"]);
  assert.equal(ruled.status, 2, "J5.3");
  assert.match(ruled.stderr, /not a change/);
});

test("J5.4/J5.5/J5.6 --auto satisfies full's opt-in, stops at a halt, and is reported", () => {
  const root = nodeProject({ name: "j54" });
  ok(root, ["open", "w1", "--path", "full", "--session", SESSION, "--auto"]);
  writeFile(join(root, ".kiln", "work", "w1", "spec.md"), "# spec\n");
  ok(root, ["gate", "w1", "spec", "--artifact", ".kiln/work/w1/spec.md", "--auto"]);
  assert.equal(state(root, "w1").gates.spec.by, "auto", "J5.4");

  const report = ok(root, ["report", "w1"]);
  assert.match(report.stdout, /Auto-ruled 1 gate/, "J5.6");
  assert.match(report.stdout, /Your gate is now the PR/);

  ok(root, ["halt", "w1", "--reason", "a migration nobody reviewed"]);
  writeFile(join(root, ".kiln", "work", "w1", "plan.md"), "# plan\n\n## Risk flags\n- none\n");
  const halted = kiln(root, ["gate", "w1", "plan", "--artifact", ".kiln/work/w1/plan.md", "--auto"]);
  assert.equal(halted.status, 2, "J5.5");
  assert.match(halted.stderr, /halted/);
});

// ─────────────────────────────────────────────── J6 · verification

test("J6.1/J6.2 the exit code is the verdict, whatever the output says", () => {
  const pass = nodeProject({ name: "j61", cmd: { test: "echo everything is fine" } });
  ok(pass, ["open", "w1", "--session", SESSION]);
  assert.match(ok(pass, ["verify", "w1"]).stdout, /green/);
  assert.match(ok(pass, ["report", "w1"]).stdout, /Verified: green, and the run describes the tree as it is now/, "J6.1 — verifying before committing is the ordinary case");
  writeFile(join(pass, "src", "app.js"), "export const a = 2;\n");
  assert.match(ok(pass, ["report", "w1"]).stdout, /tree has changed since/, "an edit after the run is not covered by it, committed or not");

  const lying = nodeProject({ name: "j62", cmd: { test: "echo All tests passed && exit 1" } });
  ok(lying, ["open", "w1", "--session", SESSION]);
  const red = kiln(lying, ["verify", "w1"]);
  assert.equal(red.status, 1, "J6.2");
  assert.doesNotMatch(red.stdout, /green/);
  assert.match(red.stderr, /All tests passed/, "the tool's own output is shown, never parsed");
});

/**
 * The implement contract says execute every task without stopping, and on a five-hour run
 * the agent stopped twice anyway — both times right after a summary table, both times on a
 * sentence promising to continue. Asked why: "the skill says run continuously and I've been
 * pausing anyway."
 *
 * The call after every task is the one place the agent is certainly reading. So the position
 * is recorded by kiln and the next move is printed there, rather than added to a document
 * loaded hours earlier.
 */
test("the per-task check records the position and says what comes next", () => {
  const project = nodeProject({
    name: "jnext",
    cmd: { test: "true", test_fast: "true" },
    steps: [{ id: "unit-fast", phase: "fast", run: "${cmd.test_fast}" }, { id: "unit", run: "${cmd.test}" }],
  });
  ok(project, ["open", "w1", "--session", SESSION]);

  const mid = ok(project, ["verify", "w1", "--phase", "fast", "--task", "3/8"]);
  assert.match(mid.stdout, /Task 4 is next — do not stop, and do not summarise/);
  assert.deepEqual(state(project, "w1").step, { task: 3, of: 8 }, "written by kiln, not narrated by the agent");

  const last = ok(project, ["verify", "w1", "--phase", "fast", "--task", "8/8"]);
  assert.match(last.stdout, /Every task is done; next is the review gate/);

  const unpositioned = ok(project, ["verify", "w1", "--phase", "fast"]);
  assert.doesNotMatch(unpositioned.stdout, /next/, "no position claimed, none invented");
});

test("J6.3/J6.4/J6.5 a phase that verified nothing refuses, and doctor said so first", () => {
  const skipped = nodeProject({ name: "j63", steps: [{ id: "unit", run: "${cmd.test}", requires: ["migrate"] }] });
  ok(skipped, ["open", "w1", "--session", SESSION]);
  const run = kiln(skipped, ["verify", "w1"]);
  assert.equal(run.status, 1, "J6.3");
  assert.match(run.stderr, /every step was skipped/);

  const stranded = kiln(skipped, ["doctor"]);
  assert.match(stranded.stdout, /can never run/, "J6.5");

  const empty = nodeProject({ name: "j64", steps: [] });
  ok(empty, ["open", "w1", "--session", SESSION]);
  assert.equal(kiln(empty, ["verify", "w1"]).status, 1, "J6.4");
  assert.match(kiln(empty, ["doctor"]).stdout, /"steps" in .kiln\/config.json is empty/);
});

test("J6.6 shipping unverified is allowed, and the report says it happened", () => {
  const root = nodeProject({ name: "j66" });
  throughPlanGate(root, "w1");
  writeReview(root, "w1");
  ok(root, ["gate", "w1", "review", "--artifact", ".kiln/work/w1/review.md", "--answer", "Approve -> no need to run the suite -> ship locally"]);

  assert.match(ok(root, ["report", "w1"]).stdout, /Verified: never/);
});

// ─────────────────────────────────────────────── J7 · many repositories

test("J7.1/J7.2 modules and the stack come from the checkout, ambiguity included", () => {
  const root = monorepo({ modules: [["AdminPage", "AdminPage", "v3-master"], ["FrontEnd", "FrontEnd", "v3-master"]] });
  const proposed = JSON.parse(ok(root, ["init", "--propose"]).stdout);

  assert.deepEqual(Object.keys(proposed.config.repo.modules), ["admin-page", "front-end"], "J7.1");
  assert.equal(proposed.config.repo.kind, "multi");
  assert.equal(proposed.detected.stack.id, "unknown", "J7.2 — composer alone names no stack kiln can load");

  writeFile(join(root, "AdminPage", "package.json"), JSON.stringify({ name: "assets", scripts: { test: "jest" } }));
  writeFile(join(root, "FrontEnd", "system", "core", "CodeIgniter.php"), "<?php\n");
  const ambiguous = JSON.parse(ok(root, ["init", "--propose"]).stdout);
  assert.deepEqual(
    [ambiguous.detected.stack.id, ...ambiguous.detected.stack.alternatives].sort(),
    ["node", "php-ci3"],
    "J7.2 — a checkout that looks like two stacks offers both",
  );
  assert.ok(ambiguous.questions.some((row) => row.key === "stack.id"));
});

test("J7.3/J7.6 a push is judged in the repository it runs in", async () => {
  const root = monorepo();
  ok(root, ["init", "--set", "stack.id=node", "--set", "vcs.integration_branch=v3-master", "--set", "stack.cmd.test=true"]);

  assert.match(ok(root, ["doctor"]).stdout, /v3-master/, "J7.6 — a module's shipping branch is protected");
  assert.equal(await bash(root, "git -C AdminPage push origin HEAD"), BLOCK, "J7.3 — AdminPage sits on v3-master");
  assert.equal(await bash(root, "cd AdminPage && git push"), BLOCK, "the chain carries the directory");
});

test("J7.4/J7.5 reconciliation and the ship plan see inside the submodules", () => {
  const root = monorepo();
  ok(root, ["init", "--set", "stack.id=node", "--set", "stack.cmd.test=true"]);
  ok(root, ["open", "w1", "--session", SESSION]);
  writeFile(join(root, "AdminPage", "src", "User.php"), "<?php // edited\n");

  assert.match(ok(root, ["scope", "w1"]).stdout, /AdminPage\/src\/User\.php/, "J7.4");

  writeFile(join(root, "README.md"), "super, edited\n");
  const ship = ok(root, ["ship", "w1"]).stdout;
  assert.match(ship, /Ship — 2 repositories/, "J7.5");
  assert.match(ship, /do not merge atomically/);
  assert.match(ship, /the order is yours/);
});

// ─────────────────────────────────────────────── J8 · the adversary

test("J8.1/J8.2/J8.5 the guards hold against the spellings a blocked agent reaches for", async () => {
  const root = nodeProject({ name: "j81" });
  throughPlanGate(root, "w1");

  for (const command of ["git push origin HEAD", "git push origin @", "git push --force origin +main", "git push"]) {
    assert.equal(await bash(root, command), BLOCK, `J8.1 ALLOWED: ${command}`);
  }
  assert.equal(await bash(root, "rm -rf /tmp/not-my-repo"), BLOCK, "J8.2");
  assert.equal(await bash(root, "git clean -xfd"), ALLOW, "inside the repo is the user's own tree");
  assert.equal(await edit(root, "../outside.js"), BLOCK, "J8.5");
});

test("J8.7 the run cannot change the terms it is judged by", async () => {
  const root = nodeProject({ name: "j87" });
  throughPlanGate(root, "w1");

  for (const command of [
    "rm -f .kiln/config.json",
    "truncate -s 0 .kiln/work/w1/state.json",
    "rm -f .git/hooks/pre-push",
    "echo x > .kiln/hooks/pre-push.mjs",
    "git push --no-verify origin feat/x",
    "git -c core.hooksPath=/dev/null push origin feat/x",
    "git config core.hooksPath /dev/null",
  ]) {
    assert.equal(await bash(root, command), BLOCK, `ALLOWED: ${command}`);
  }
  assert.equal(await edit(root, ".kiln/config.json"), BLOCK);
});

test("J8.8 the floor refuses a real push, through real git", () => {
  const root = nodeProject({ name: "j88" });
  ok(root, ["doctor", "--write"]);
  const remote = tempRoot("kiln-j88-remote-");
  git(remote, ["init", "-q", "--bare"]);
  git(root, ["remote", "add", "origin", remote]);

  const push = spawnSync("git", ["push", "origin", "HEAD"], { cwd: root, encoding: "utf8" });
  assert.equal(push.status, 1, push.stderr);
  assert.match(push.stderr, /main is a protected branch/);
  assert.match(push.stderr, /git resolved the destination to refs\/heads\/main/);
});

// ─────────────────── J9 · where two separate fixes could describe two different runs

test("J9.1 an auto run on full reaches a pull request with no human gate, as designed", async () => {
  const root = nodeProject({ name: "j91" });
  ok(root, ["open", "w1", "--path", "full", "--session", SESSION, "--auto"]);

  for (const key of ["spec", "plan", "review", "ship"]) {
    if (key === "review") writeReview(root, "w1");
    else if (key !== "ship") writeFile(join(root, ".kiln", "work", "w1", `${key}.md`), key === "plan" ? "# plan\n\n## Risk flags\n- none\n" : `# ${key}\n`);
    assert.equal(ok(root, ["gate", "w1", key, "--auto"]).status, 0, key);
  }
  assert.equal(await bash(root, "gh pr create --fill"), ALLOW, "the design says the PR becomes the gate");
  assert.match(ok(root, ["report", "w1"]).stdout, /Auto-ruled 4 gates/, "and every one of them is named");
});

test("J9.2 a session drives one work, and halt actually gives it back", () => {
  const root = nodeProject({ name: "j92" });
  ok(root, ["open", "w1", "--session", "s-j92"]);

  const second = kiln(root, ["open", "w2", "--session", "s-j92"]);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /already drives work w1/);

  ok(root, ["halt", "w1", "--reason", "parked"]);
  assert.equal(kiln(root, ["open", "w2", "--session", "s-j92"]).status, 0, "the refusal named halt, so halt has to work");

  const claimed = ok(root, ["open", "w3"]);
  assert.doesNotMatch(claimed.stdout, /took over/, "opening a fresh work takes nothing from anyone");
});

test("J9.3 the free ratchet closes the moment the tree changes", () => {
  const root = nodeProject({ name: "j93" });
  ok(root, ["open", "w1", "--path", "full", "--session", SESSION]);
  assert.equal(kiln(root, ["ratchet", "w1", "bounded"]).status, 0, "nothing recorded, nothing to launder");

  ok(root, ["ratchet", "w1", "full"]);
  writeFile(join(root, "src", "app.js"), "export const a = 3;\n");
  const down = kiln(root, ["ratchet", "w1", "bounded"]);
  assert.equal(down.status, 1, "a changed tree is something to launder");
  assert.match(down.stderr, /only goes up/);
});

test("J9.4 a work directory with no state warns, and the session keeps running", async () => {
  const root = nodeProject({ name: "j94" });
  throughPlanGate(root, "w1");
  mkdirSync(join(root, ".kiln", "work", "half-made"), { recursive: true });

  assert.equal(await bash(root, "npm test"), ALLOW, "one half-made directory does not stop everything");
  assert.equal(await edit(root, "src/app.js"), ALLOW);

  const doctor = kiln(root, ["doctor"]);
  assert.match(doctor.stdout, /artifacts but no state.json/);
  assert.match(ok(root, ["list"]).stdout, /half-made\s+unopened/);
});

test("J9.5 a config init wrote is a config that verifies", () => {
  const root = initRepo(tempRoot("kiln-j95-"));
  writeFile(join(root, "package.json"), JSON.stringify({ name: "app", scripts: { test: "true", lint: "true" } }));
  commitAll(root, "first");

  ok(root, ["init"]);
  assert.match(ok(root, ["doctor"]).stdout, /Ready\./, "what init writes, doctor accepts");

  ok(root, ["open", "w1", "--session", SESSION]);
  assert.match(ok(root, ["verify", "w1"]).stdout, /green/, "and what doctor accepts, verify can run");
});

test("J9.6 scope and ship agree about which files are this run's", () => {
  const root = monorepo();
  ok(root, ["init", "--set", "stack.id=node", "--set", "stack.cmd.test=true"]);
  writeFile(join(root, "README.md"), "dirty before the work started\n");

  ok(root, ["open", "w1", "--session", SESSION]);
  writeFile(join(root, "AdminPage", "src", "User.php"), "<?php // mine\n");

  const scope = ok(root, ["scope", "w1"]).stdout;
  const ship = ok(root, ["ship", "w1"]).stdout;
  assert.match(scope, /actual 1/, "the pre-existing README is not this run's doing");
  assert.match(ship, /Ship — 1 repository/, "and the ship plan says the same number");
  assert.doesNotMatch(ship, /README/);
});

test("J9.7 a skipped step is not a pass, in all three places that say so", () => {
  const root = nodeProject({ name: "j97", steps: [{ id: "unit", run: "${cmd.test}", requires: ["migrate"] }] });
  ok(root, ["open", "w1", "--session", SESSION]);

  const run = kiln(root, ["verify", "w1"]);
  assert.equal(run.status, 1);
  assert.doesNotMatch(run.stdout, /green/);
  assert.match(ok(root, ["report", "w1"]).stdout, /Verified: never/, "the report agrees with the verdict");
  assert.match(kiln(root, ["doctor"]).stdout, /can never run/, "and doctor said so before either");
});

/**
 * The invariant, not the contents: whatever `doctor` prints as protected is what the guard
 * refuses. A branch a submodule merely sits on is not a shipping branch, so it is
 * deliberately absent — `vcs.integration_branch` says where a pull request goes.
 */
test("J9.8 every branch doctor calls protected is one the guard refuses", async () => {
  const root = monorepo({ modules: [["AdminPage", "AdminPage", "v3-master"]] });
  ok(root, ["init", "--set", "stack.id=node", "--set", "stack.cmd.test=true", "--set", "vcs.integration_branch=v3-develop"]);

  const printed = ok(root, ["doctor"]).stdout.match(/protected branches: (.+)/)[1].split(", ");
  assert.ok(printed.includes("v3-develop"), "the declared shipping branch is protected without being listed");

  for (const branch of printed) {
    assert.equal(await bash(root, `git push origin ${branch}`), BLOCK, `printed but allowed: ${branch}`);
  }
  assert.equal(
    await bash(root, "git -C AdminPage push origin v3-master"),
    ALLOW,
    "a branch a checkout sits on is not a branch kiln ships to",
  );
});

test("J9.9 an auto-ruled gate records words, not a click", () => {
  const root = nodeProject({ name: "j99" });
  ok(root, ["open", "w1", "--session", SESSION, "--auto"]);
  writeFile(join(root, ".kiln", "work", "w1", "plan.md"), "# plan\n\n## Risk flags\n- none\n");
  ok(root, ["gate", "w1", "plan", "--artifact", ".kiln/work/w1/plan.md", "--auto"]);

  const record = state(root, "w1").gates.plan;
  assert.equal(record.by, "auto");
  assert.match(record.answer, /ruled by auto mode, not by the user/, "the record says who decided");
  assert.notEqual(record.artifact_sha, null, "and which document it decided about");
});

test("J9.10 the floor and the guard protect the same branches", () => {
  const root = nodeProject({ name: "j910" });
  ok(root, ["config", "set", "vcs.protected=main"]);
  ok(root, ["doctor", "--write"]);

  const remote = tempRoot("kiln-j910-remote-");
  git(remote, ["init", "-q", "--bare"]);
  git(root, ["remote", "add", "origin", remote]);

  const push = spawnSync("git", ["push", "origin", "HEAD"], { cwd: root, encoding: "utf8" });
  assert.equal(push.status, 1, "the floor reads the same vcs.protected the guard does");
  assert.match(push.stderr, /main is a protected branch/);
});
