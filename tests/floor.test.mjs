import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, loadConfig } from "../lib/config.mjs";
import { STATUS, runChecks } from "../lib/doctor.mjs";
import { floorStatus, installFloor, runnerPath } from "../lib/floor.mjs";
import { refusal } from "../lib/floor/pre-push.mjs";
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
  assert.match(row.detail, /add `node "\$\(git rev-parse --show-toplevel\)\/\.kiln\/hooks\/pre-push\.mjs" "\$@"`/, "the exact line to add");
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
