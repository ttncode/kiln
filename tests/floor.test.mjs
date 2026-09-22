import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, loadConfig } from "../lib/config.mjs";
import { STATUS, runChecks } from "../lib/doctor.mjs";
import { floorStatus, hookBody, installFloor, runnerPath } from "../lib/floor.mjs";
import { gitOutput } from "../lib/init.mjs";
import { refusal } from "../lib/floor/pre-push.mjs";
import { kiln, nodeProject, ok } from "./helpers/journey.mjs";
import { cleanupFixtures, commitAll, git, initRepo, tempRoot, writeConfig, writeFile } from "./helpers/fixture.mjs";

after(cleanupFixtures);

function project(protectedBranches = ["main"]) {
  const root = initRepo(tempRoot("kiln-floor-"));
  writeFile(join(root, "a.txt"), "a");
  commitAll(root, "first");
  writeConfig(root, { ...DEFAULTS, vcs: { ...DEFAULTS.vcs, protected: protectedBranches } });
  writeFile(join(root, ".kiln", "rules", "index.md"), "# rules\n");
  return root;
}

test("git resolves the destination before the hook is asked", () => {
  assert.deepEqual(refusal("HEAD abc123 refs/heads/main def456", ["main"]), { branch: "main", remoteRef: "refs/heads/main" });
  assert.equal(refusal("HEAD abc123 refs/heads/feat/x def456", ["main"]), null);
  assert.equal(refusal("", ["main"]), null);
});

/**
 * The whole claim, end to end: a real push, through real git, with a spelling the
 * command-line scan had to be taught about one at a time.
 */
test("a real push to a protected branch is refused by git itself", () => {
  const root = project(["main"]);
  installFloor(root);
  const remote = tempRoot("kiln-floor-remote-");
  git(remote, ["init", "-q", "--bare"]);
  git(root, ["remote", "add", "origin", remote]);

  const push = (...args) => spawnSync("git", ["push", ...args], { cwd: root, encoding: "utf8" });
  const blocked = push("origin", "HEAD");
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.match(blocked.stderr, /main is a protected branch/);
  assert.match(blocked.stderr, /git resolved the destination to refs\/heads\/main/);

  git(root, ["checkout", "-q", "-b", "feat/x"]);
  assert.equal(push("origin", "HEAD").status, 0, "a feature branch still pushes");
});

test("the floor is installed into every checkout, submodules included", () => {
  const sub = initRepo(tempRoot("kiln-floor-sub-"));
  writeFile(join(sub, "a.txt"), "a");
  commitAll(sub, "sub");
  const root = project();
  git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "mod"]);
  commitAll(root, "add submodule");

  installFloor(root);
  assert.ok(existsSync(runnerPath(root)));
  assert.deepEqual(floorStatus(root).map((row) => row.state), ["installed", "installed"]);
  assert.match(readFileSync(join(root, ".git", "hooks", "pre-push"), "utf8"), /installed by kiln/);
});

test("a hook that was already there is reported, never replaced", () => {
  const root = project();
  writeFile(join(root, ".git", "hooks", "pre-push"), "#!/bin/sh\n# husky\n");
  installFloor(root);

  assert.equal(readFileSync(join(root, ".git", "hooks", "pre-push"), "utf8"), "#!/bin/sh\n# husky\n", "a project's own hook is not kiln's to replace");
  assert.equal(floorStatus(root)[0].state, "foreign");

  const [row] = runChecks(root, loadConfig(root)).filter((r) => r.title === "push floor");
  assert.equal(row.status, STATUS.warn);
  assert.match(row.detail, /will not replace it/);
});

test("core.hooksPath is where the hook goes, not a reason to skip it", () => {
  const root = project();
  git(root, ["config", "core.hooksPath", ".husky"]);
  installFloor(root);

  assert.equal(floorStatus(root)[0].state, "installed", "git reads .husky here, so that is where it belongs");
  const [row] = runChecks(root, loadConfig(root)).filter((r) => r.title === "push floor");
  assert.equal(row.status, STATUS.ok);
});

test("doctor says the floor is missing before anyone installs it", () => {
  const root = project();
  const [row] = runChecks(root, loadConfig(root)).filter((r) => r.title === "push floor");
  assert.equal(row.status, STATUS.warn);
  assert.match(row.detail, /doctor --write/);
});

/**
 * Measured on a real clone with `core.hooksPath=.husky` — the setup an enormous share of
 * JavaScript repositories use. kiln wrote its hook into `.git/hooks`, git read `.husky`,
 * so the floor was **absent**, `kiln doctor` printed `Ready.`, and a real push to a
 * protected branch went through.
 *
 * `core.hooksPath` is not an obstacle; it is where the hooks live. husky sets it, pre-commit
 * sets it, and every hook-aware tool installs into whatever it points at.
 */
test("the floor installs where git actually reads hooks", () => {
  const root = project(["main"]);
  writeFile(join(root, ".husky", "pre-commit"), "#!/bin/sh\n# husky\n");
  git(root, ["config", "core.hooksPath", ".husky"]);

  installFloor(root);
  assert.ok(existsSync(join(root, ".husky", "pre-push")), "into .husky, not into .git/hooks");
  assert.equal(existsSync(join(root, ".git", "hooks", "pre-push")), false, "where git would never look");
  assert.deepEqual(floorStatus(root).map((row) => row.state), ["installed"]);
});

test("a hook already in the configured directory is reported, never replaced", () => {
  const root = project(["main"]);
  writeFile(join(root, ".husky", "pre-push"), "#!/bin/sh\n# husky owns this\n");
  git(root, ["config", "core.hooksPath", ".husky"]);
  installFloor(root);

  assert.equal(readFileSync(join(root, ".husky", "pre-push"), "utf8"), "#!/bin/sh\n# husky owns this\n");
  const [row] = runChecks(root, loadConfig(root)).filter((r) => r.title === "push floor");
  assert.equal(row.status, STATUS.warn);
  assert.match(row.detail, /--show-superproject-working-tree \|\| git rev-parse --show-toplevel/, "the line a submodule can also use");
  assert.doesNotMatch(row.detail, /add `exec node "\$\(git rev-parse --show-toplevel\)/, "not the line that broke every submodule push");
});

test("a hooksPath outside the checkout is named, because kiln cannot install there", () => {
  const root = project(["main"]);
  git(root, ["config", "core.hooksPath", "/etc/git-hooks-elsewhere"]);

  assert.deepEqual(floorStatus(root).map((row) => row.state), ["elsewhere"]);
  const [row] = runChecks(root, loadConfig(root)).filter((r) => r.title === "push floor");
  assert.match(row.detail, /the floor is absent/);
});

/**
 * "Ready." over a warning is right for most warnings. It was wrong for one: a missing push
 * floor means D7 item 1 has lost a layer, and on a husky project that was the state of
 * every run while the last line said Ready.
 */
test("doctor's closing line does not read as fine when something is warned about", () => {
  const root = project(["main"]);
  writeConfig(root, {
    ...DEFAULTS,
    stack: { id: "node", cmd: { test: "true" }, steps: [{ id: "unit", run: "${cmd.test}" }] },
  });
  writeFile(join(root, ".husky", "pre-push"), "#!/bin/sh\n# husky owns this\n");
  git(root, ["config", "core.hooksPath", ".husky"]);
  installFloor(root);

  const bin = new URL("../bin/kiln.mjs", import.meta.url).pathname;
  const run = spawnSync(process.execPath, [bin, "doctor"], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, `a warning is still not a reason to stop: ${run.stdout}`);
  assert.match(run.stdout, /Ready, with 1 warning\(s\): push floor\./);
});

function submoduleProject() {
  const sub = initRepo(tempRoot("kiln-floor-sub2-"));
  writeFile(join(sub, "a.txt"), "a");
  commitAll(sub, "sub");
  const root = project(["main"]);
  git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "mod"]);
  commitAll(root, "add submodule");
  installFloor(root);
  return root;
}

function remoteFor(checkout) {
  const remote = tempRoot("kiln-floor-remote2-");
  git(remote, ["init", "-q", "--bare"]);
  gitOutput(checkout, ["remote", "remove", "origin"]);
  git(checkout, ["remote", "add", "origin", remote]);
  return remote;
}

/**
 * Measured on a real monorepo: every push from every one of four submodules died with
 * `Cannot find module .../AdminPage/.kiln/hooks/pre-push.mjs`. `--show-toplevel` inside a
 * submodule is the submodule — git's documentation says so — and `.kiln/` lives only in the
 * superproject. The branch being pushed was not protected; the floor never got to look.
 */
test("a push from a submodule reaches the superproject's runner", () => {
  const root = submoduleProject();
  const mod = join(root, "mod");
  remoteFor(mod);

  const blocked = spawnSync("git", ["push", "origin", "HEAD:refs/heads/main"], { cwd: mod, encoding: "utf8" });
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.match(blocked.stderr, /main is a protected branch/);
  assert.doesNotMatch(blocked.stderr, /Cannot find module/, "the runner is found from inside the submodule");

  const feature = spawnSync("git", ["push", "origin", "HEAD:refs/heads/feature/x"], { cwd: mod, encoding: "utf8" });
  assert.equal(feature.status, 0, `an unprotected branch still pushes: ${feature.stderr}`);
});

/**
 * git exports GIT_DIR and GIT_WORK_TREE into every hook and they beat `-C`, so a walk that
 * does not clear them answers for the starting repository at every step. Measured with them
 * left set: a submodule two levels down got an empty answer at the second step and its push
 * to a protected branch was allowed unchecked.
 */
test("the walk survives the environment git hands a hook", () => {
  const root = submoduleProject();
  const mod = join(root, "mod");
  remoteFor(mod);

  const inherited = { ...process.env, GIT_DIR: gitOutput(mod, ["rev-parse", "--absolute-git-dir"]) };
  const run = spawnSync("git", ["push", "origin", "HEAD:refs/heads/main"], { cwd: mod, encoding: "utf8", env: inherited });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /main is a protected branch/);
});

/**
 * A floor that refuses a push it cannot judge is a wall. D33: no config means kiln is not
 * driving this repository, so it says so once and gets out of the way.
 */
test("no runner above this checkout allows the push, and says why", () => {
  const alone = initRepo(tempRoot("kiln-floor-alone-"));
  writeFile(join(alone, "a.txt"), "a");
  commitAll(alone, "first");
  writeFile(join(alone, ".git", "hooks", "pre-push"), hookBody());
  spawnSync("chmod", ["755", join(alone, ".git", "hooks", "pre-push")]);
  remoteFor(alone);

  const run = spawnSync("git", ["push", "origin", "HEAD:refs/heads/main"], { cwd: alone, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /no \.kiln\/hooks\/pre-push\.mjs above/);
});

/**
 * Measured, and it is the worse half of this pair. In a linked worktree
 * `--absolute-git-dir` is `.git/worktrees/<name>`, so kiln installed the hook there,
 * `floorStatus` read it back as `installed`, `doctor` printed `Ready.` — and git reads
 * `.git/hooks`. A real push to a protected branch succeeded, exit 0.
 *
 * D7 item 1 reported as held while absent: the husky bug this function was written to fix,
 * one directory over. `git rev-parse --git-path hooks` answers commondir and core.hooksPath
 * in one call, which is why nothing here computes a path.
 */
test("a worktree reads hooks from the common dir, so that is where the floor goes", () => {
  const root = project(["main"]);
  const tree = join(root, "..", `${root.split("/").pop()}-wt`);
  git(root, ["add", "-f", ".kiln"]);
  commitAll(root, "kiln tracked");
  git(root, ["worktree", "add", "-q", tree, "-b", "wt"]);

  installFloor(tree);
  const reads = gitOutput(tree, ["rev-parse", "--git-path", "hooks"]);
  assert.ok(existsSync(join(reads, "pre-push")), "installed where git will actually look");

  const remote = tempRoot("kiln-floor-wt-remote-");
  git(remote, ["init", "-q", "--bare"]);
  git(tree, ["remote", "add", "origin", remote]);
  const push = spawnSync("git", ["push", "origin", "HEAD:refs/heads/main"], { cwd: tree, encoding: "utf8" });
  assert.equal(push.status, 1, `a protected push from a worktree is refused: ${push.stdout}${push.stderr}`);
  assert.match(push.stderr, /main is a protected branch/);
});

/**
 * The hook's own first line says `Regenerate with kiln doctor --write`, and the installer
 * skipped anything already present — so a hook from an older kiln stayed forever and nobody
 * who had installed could receive a fix. A remedy naming a command that does nothing.
 */
test("a hook written by an older kiln is replaced, because it says it will be", () => {
  const root = project(["main"]);
  installFloor(root);
  const hook = join(root, ".git", "hooks", "pre-push");
  writeFile(hook, `${readFileSync(hook, "utf8")}\n# an older kiln wrote this\n`);

  assert.equal(floorStatus(root)[0].state, "stale");
  const [warned] = runChecks(root, loadConfig(root)).filter((r) => r.title === "push floor");
  assert.equal(warned.status, STATUS.warn);
  assert.match(warned.detail, /written by an older kiln/);

  assert.deepEqual(installFloor(root), [hook], "and --write replaces it");
  assert.equal(readFileSync(hook, "utf8"), hookBody());
  assert.equal(floorStatus(root)[0].state, "installed");
});

/** A hook that is present and a hook that can run are different facts. */
test("an installed hook with no runner above it is not called installed", () => {
  const root = project(["main"]);
  installFloor(root);
  rmSync(runnerPath(root));
  assert.equal(floorStatus(root)[0].state, "no-runner");

  const [row] = runChecks(root, loadConfig(root)).filter((r) => r.title === "push floor");
  assert.equal(row.status, STATUS.warn);
  assert.match(row.detail, /it checks nothing/);
});

/**
 * `/plugin update kiln` replaces the plugin and touches nothing in the project, so a
 * checkout that already had the floor keeps the hook the older version wrote. Doctor calls
 * that `stale` — but only if somebody runs doctor, and the one instruction kiln gave about
 * updating was `/plugin update kiln. That is all.`
 *
 * Measured on a real monorepo after rc.19: five checkouts all `stale`, having run the whole
 * of rc.18 with the submodule bug rc.19 fixed, while every run printed `Ready.`
 */
test("opening a work says so when the push floor is not armed", () => {
  const root = nodeProject({ name: "floor-open" });
  ok(root, ["init"]);
  writeFile(join(root, ".git", "hooks", "pre-push"), "# installed by kiln\n# an older body\n");

  const run = kiln(root, ["open", "w1", "--session", "s"]);
  assert.equal(run.status, 0, "a degraded floor warns; it does not refuse to start work");
  assert.match(run.stderr, /push floor is not armed/);
  assert.match(run.stderr, /kiln doctor --write/, "and names the command that repairs it");
});

test("an armed floor says nothing at open", () => {
  const root = nodeProject({ name: "floor-quiet" });
  ok(root, ["init"]);
  const run = kiln(root, ["open", "w2", "--session", "s"]);
  assert.doesNotMatch(run.stderr, /push floor/, "a line printed every run is a line nobody reads");
});
