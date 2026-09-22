import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, loadConfig } from "../lib/config.mjs";
import { STATUS, runChecks, worstStatus } from "../lib/doctor.mjs";
import { newWork, statePath, writeState } from "../lib/state.mjs";
import { cleanupFixtures, commitAll, git, initRepo, tempRoot, writeConfig, writeFile } from "./helpers/fixture.mjs";

after(cleanupFixtures);

function project(overrides = {}) {
  const root = tempRoot("kiln-doctor-");
  writeConfig(root, { ...DEFAULTS, ...overrides, stack: { id: "node", cmd: { test: "npm test", typecheck: "tsc --noEmit" }, ...overrides.stack } });
  writeFile(join(root, ".kiln", "rules", "index.md"), "# Project rules\n\n| Trigger | Rule file |\n|---|---|\n");
  return root;
}

const results = (root) => runChecks(root, loadConfig(root));
const row = (root, title) => results(root).filter((r) => r.title === title);

test("every check reports a title and a detail, not undefined", () => {
  for (const r of results(project())) {
    assert.ok(r.title, "a check with no title");
    assert.ok(r.detail, `${r.title} reported no detail`);
    assert.ok(Object.values(STATUS).includes(r.status), `${r.title} has status ${r.status}`);
  }
});

test("a healthy project is Ready", () => {
  assert.equal(worstStatus(results(project())), STATUS.ok);
});

test("D54: node on PATH is checked here, because nothing can check it at runtime", () => {
  assert.equal(row(project(), "node on PATH")[0].status, STATUS.ok);
});

test("D60.1: a step with no command fails, and names the key to set", () => {
  const root = project({ stack: { cmd: { test: "npm test" }, steps: [{ id: "typecheck", run: "${cmd.typecheck}" }] } });
  const [stack] = row(root, "stack");
  assert.equal(stack.status, STATUS.fail);
  assert.match(stack.detail, /stack\.cmd\.typecheck/);
  assert.equal(worstStatus(results(root)), STATUS.fail);
});

test("D20: an unrouted rule is named, because unrouted is dead weight", () => {
  const root = project();
  writeFile(join(root, ".kiln", "rules", "orphan.md"), "# nobody routed this\n");

  const [routing] = row(root, "rules routing");
  assert.equal(routing.status, STATUS.fail);
  assert.match(routing.detail, /orphan\.md/);
});

test("D20: a routed rule passes", () => {
  const root = project();
  writeFile(join(root, ".kiln", "rules", "index.md"), "| Trigger | Rule file |\n|---|---|\n| `src/**` | routed.md |\n");
  writeFile(join(root, ".kiln", "rules", "routed.md"), "# routed\n");
  assert.equal(row(root, "rules routing")[0].status, STATUS.ok);
});

test("D20: the budget warns rather than fails — volume is a trend, not a blocker", () => {
  const root = project({ rules: { budget_lines: 2 } });
  writeFile(join(root, ".kiln", "rules", "index.md"), "x\n".repeat(50));
  const [budget] = row(root, "rules budget");
  assert.equal(budget.status, STATUS.warn);
  assert.match(budget.detail, /of 2 lines/);
});

test("D39: an older schema warns and says the file was not rewritten", () => {
  const root = project();
  writeConfig(root, { schema_version: 0, stack: { id: "node", cmd: { test: "t", typecheck: "t" } } });
  const [schema] = row(root, "config schema");
  assert.equal(schema.status, STATUS.warn);
  assert.match(schema.detail, /did not rewrite/);
});

test("D33: an unreadable state fails, because it blocks every guarded write", () => {
  const root = project();
  writeState(root, newWork({ id: "42", sessionId: "s", base: "aaa" }));
  writeFile(statePath(root, "42"), "{ not json");

  const [work] = row(root, "work");
  assert.equal(work.status, STATUS.fail);
  assert.match(work.detail, /42/);
});

test("doctor exits non-zero on a failure, so a wrapper can gate on it", () => {
  const root = project({ stack: { cmd: {}, steps: [{ id: "unit", run: "${cmd.test}" }] } });
  const bin = new URL("../bin/kiln.mjs", import.meta.url).pathname;
  const run = spawnSync(process.execPath, [bin, "doctor"], { cwd: root, encoding: "utf8" });

  assert.equal(run.status, 1);
  assert.match(run.stdout, /would stop a run/);
});

/**
 * `init` run from a feature branch once protected that branch and left the branch the
 * project ships from open to a push. The warning that caught it is gone because the hole
 * is: a branch kiln would open a pull request against is added to the protected set,
 * whatever the file says.
 */
test("D7 item 1: the branch a project ships from is protected whether or not it is listed", () => {
  const root = tempRoot("kiln-doctor-branch-");
  initRepo(root);
  writeFile(join(root, "a.txt"), "a");
  commitAll(root, "first");
  git(root, ["remote", "add", "origin", "https://github.com/acme/app.git"]);
  git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  writeConfig(root, { ...DEFAULTS, vcs: { ...DEFAULTS.vcs, protected: ["feat/trying-kiln-out"] } });
  writeFile(join(root, ".kiln", "rules", "index.md"), "# rules\n");

  const [row] = runChecks(root, loadConfig(root)).filter((r) => r.title === "protected branches");
  assert.equal(row.status, STATUS.ok);
  assert.match(row.detail, /main/, "integration_branch is main, so main is protected");
});

test("D88: doctor --write repairs the one thing it can repair without guessing", () => {
  const root = tempRoot("kiln-repair-");
  initRepo(root);
  writeFile(join(root, "a.txt"), "a");
  commitAll(root, "first");
  git(root, ["remote", "add", "origin", "https://github.com/acme/app.git"]);
  git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  writeConfig(root, { ...DEFAULTS, vcs: { ...DEFAULTS.vcs, protected: ["feat/x"] } });
  writeFile(join(root, ".kiln", "rules", "index.md"), "# rules\n");

  const bin = new URL("../bin/kiln.mjs", import.meta.url).pathname;
  const run = spawnSync(process.execPath, [bin, "doctor", "--write"], { cwd: root, encoding: "utf8" });

  assert.equal(run.status, 0);
  assert.match(run.stdout, /add "main" to vcs.protected/);
  assert.deepEqual(loadConfig(root).config.vcs.protected, ["feat/x", "main"]);
});

test("doctor --write on a healthy project repairs nothing and says so", () => {
  const root = project();
  const bin = new URL("../bin/kiln.mjs", import.meta.url).pathname;
  const run = spawnSync(process.execPath, [bin, "doctor", "--write"], { cwd: root, encoding: "utf8" });
  assert.match(run.stdout, /Nothing to repair/);
});

test("D81: a per-module map outside a multi-repo config is named, not resolved silently", () => {
  const root = project();
  writeConfig(root, { ...DEFAULTS, vcs: { ...DEFAULTS.vcs, integration_branch: { admin: "v3-master" } } });
  const found = runChecks(root, { config: loadConfig(root).config, migrated: false })
    .find((row) => row.title === "integration branch");

  assert.equal(found.status, STATUS.fail);
  assert.match(found.detail, /repo\.kind "multi"/);
});

test("D81: a per-module map is reported per module, because something reads it now", () => {
  const root = project();
  writeConfig(root, {
    ...DEFAULTS,
    repo: { kind: "multi", root: null, modules: { admin: "AdminPage" } },
    vcs: { ...DEFAULTS.vcs, integration_branch: { admin: "v3-master" } },
  });
  const rows = runChecks(root, { config: loadConfig(root).config, migrated: false });

  const branch = rows.find((row) => row.title === "integration branch");
  assert.equal(branch.status, STATUS.ok);
  assert.match(branch.detail, /admin → v3-master/);

  const guarded = rows.find((row) => row.title === "protected branches");
  assert.match(guarded.detail, /v3-master/, "a branch a module ships from is a branch kiln must not push to");
});

test("a map with no multi kind still fails, because then nothing resolves it", () => {
  const root = project();
  writeConfig(root, { ...DEFAULTS, vcs: { ...DEFAULTS.vcs, integration_branch: { admin: "v3-master" } } });
  const found = runChecks(root, { config: loadConfig(root).config, migrated: false })
    .find((row) => row.title === "integration branch");

  assert.equal(found.status, STATUS.fail);
});

test("doctor says when a work has no owner, because its gate enforces nothing", () => {
  const root = project();
  writeState(root, { ...newWork({ id: "42", sessionId: null, base: "aaa" }) });
  writeState(root, { ...newWork({ id: "99", sessionId: null, base: "bbb" }) });

  const [row] = runChecks(root, loadConfig(root)).filter((r) => r.title === "work is owned");
  assert.equal(row.status, STATUS.fail, "two unowned works cannot be claimed automatically");
  assert.match(row.detail, /enforces nothing/);
});

test("doctor trusts the declared shipping branch, not a detection fallback", () => {
  const root = tempRoot("kiln-doctor-declared-");
  initRepo(root);
  writeFile(join(root, "a.txt"), "a");
  commitAll(root, "first");
  git(root, ["checkout", "-q", "-b", "fix/some-feature"]);
  writeConfig(root, {
    ...DEFAULTS,
    vcs: { ...DEFAULTS.vcs, integration_branch: "v3-develop-tps", protected: ["v3-develop-tps", "v3-master"] },
    stack: { id: "node", cmd: { test: "t" }, steps: [{ id: "unit", run: "${cmd.test}" }] },
  });
  writeFile(join(root, ".kiln", "rules", "index.md"), "# rules\n");

  const [row] = runChecks(root, loadConfig(root)).filter((r) => r.title === "protected branches");
  assert.equal(row.status, STATUS.ok, "origin/HEAD is unset here, and the branch you stand on is not the answer");
});

test("a declared shipping branch joins the protected set rather than producing a finding", () => {
  const root = tempRoot("kiln-doctor-undeclared-");
  initRepo(root);
  writeConfig(root, {
    ...DEFAULTS,
    vcs: { ...DEFAULTS.vcs, integration_branch: "release", protected: ["main"] },
    stack: { id: "node", cmd: { test: "t" }, steps: [{ id: "unit", run: "${cmd.test}" }] },
  });
  writeFile(join(root, ".kiln", "rules", "index.md"), "# rules\n");

  const [row] = runChecks(root, loadConfig(root)).filter((r) => r.title === "protected branches");
  assert.equal(row.status, STATUS.ok);
  assert.match(row.detail, /release/);
  assert.match(row.detail, /main/);
});

test("a remote default that disagrees with the declaration is a warning, not a failure", () => {
  const root = tempRoot("kiln-doctor-remote-");
  initRepo(root);
  writeFile(join(root, "a.txt"), "a");
  commitAll(root, "first");
  const origin = tempRoot("kiln-doctor-origin-");
  git(origin, ["init", "-q", "--bare"]);
  git(root, ["remote", "add", "origin", origin]);
  git(root, ["push", "-q", "origin", "HEAD:main"]);
  git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  writeConfig(root, {
    ...DEFAULTS,
    vcs: { ...DEFAULTS.vcs, integration_branch: "v3-develop-tps", protected: ["v3-develop-tps"] },
    stack: { id: "node", cmd: { test: "t" }, steps: [{ id: "unit", run: "${cmd.test}" }] },
  });
  writeFile(join(root, ".kiln", "rules", "index.md"), "# rules\n");

  const [row] = runChecks(root, loadConfig(root)).filter((r) => r.title === "protected branches");
  assert.equal(row.status, STATUS.warn);
  assert.match(row.detail, /remote's default is "main"/);
});

/**
 * A stack adapter is a JSON file anyone may write, and the shipped php-ci3 one carried a
 * step that could never run in the phase that decides green. Nothing checked, so nothing
 * said — and `kiln verify` printed green over it on a real project.
 */
test("doctor fails a step whose required effect nothing in its phase provides", () => {
  const root = tempRoot("kiln-doctor-stranded-");
  initRepo(root);
  writeConfig(root, {
    ...DEFAULTS,
    stack: {
      id: "node",
      cmd: { test: "t", migrate: "m" },
      steps: [
        { id: "migrate", run: "${cmd.migrate}", provides: "migrate", phase: "fast" },
        { id: "unit", run: "${cmd.test}", requires: ["migrate"] },
      ],
    },
  });
  writeFile(join(root, ".kiln", "rules", "index.md"), "# rules\n");

  const [row] = runChecks(root, loadConfig(root)).filter((r) => r.title === "stack");
  assert.equal(row.status, STATUS.fail);
  assert.match(row.detail, /no full-phase step provides/);
  assert.match(row.detail, /can never run/);
});

/**
 * Auto mode rules gates on the user's behalf and is off by default, so the one thing that
 * must never happen is finding out afterwards. It is reported whichever way it is set.
 */
test("doctor says whether kiln will rule a gate for you", () => {
  const off = runChecks(project(), loadConfig(project())).filter((r) => r.title === "auto mode");
  assert.equal(off.length, 1);

  const root = project({ auto: { bounded: true } });
  const [row] = runChecks(root, loadConfig(root)).filter((r) => r.title === "auto mode");
  assert.equal(row.status, STATUS.warn);
  assert.match(row.detail, /ON for bounded/);
  assert.match(row.detail, /kiln report/, "the finding names where to see what it decided");
});

/* --- the rules router: every row that cannot resolve is named --- */

function router(rows, files = {}) {
  const root = project();
  writeFile(join(root, ".kiln", "rules", "index.md"), "| Trigger | Rule file |\n|---|---|\n" + rows.map((r) => `| ${r} |\n`).join(""));
  for (const [name, body] of Object.entries(files)) writeFile(join(root, ".kiln", "rules", name), body);
  initRepo(root);
  writeFile(join(root, "src", "app.js"), "1\n");
  commitAll(root, "first");
  return root;
}

const routing = (root) => row(root, "rules routing");

/**
 * The failure this check exists to prevent is Cursor's: a malformed rule is skipped with
 * no warning and no log, so the rule is filed, it is routed, and the agent behaves as
 * though it had never been written. There is no symptom to debug.
 */
test("E07: a row filling one column of two routes nothing, and says so", () => {
  const [finding] = routing(router(["src/** |"]));
  assert.equal(finding.status, STATUS.fail);
  assert.match(finding.detail, /one of the two columns/);
  assert.match(finding.detail, /src\/\*\*/, "the row is named, or there is nothing to fix");
});

test("E08: a rule routed but not on disk is a failure, not an empty read", () => {
  const [finding] = routing(router(["src/** | ghost.md"]));
  assert.equal(finding.status, STATUS.fail);
  assert.match(finding.detail, /ghost\.md/);
});

test("E11: a rule file naming a path outside .kiln/rules/ is refused", () => {
  const [finding] = routing(router(["src/** | ../../../etc/passwd"]));
  assert.equal(finding.status, STATUS.fail);
  assert.match(finding.detail, /not a file in \.kiln\/rules\//);
});

test("a table with rows but no separator is not a table, and nothing in it routes", () => {
  const root = project();
  writeFile(join(root, ".kiln", "rules", "index.md"), "| src/** | a.md |\n");
  const [finding] = routing(root);
  assert.equal(finding.status, STATUS.fail);
  assert.match(finding.detail, /separator/);
});

/**
 * The other half of "unrouted is dead weight". The file is routed, the row is well-formed,
 * and the trigger still reaches no file in this project — so the rule is never applied and
 * nothing anywhere would have said so.
 */
test("E09: a trigger matching no file in the project is a dead route", () => {
  const [finding] = routing(router(["app/legacy/** | legacy.md"], { "legacy.md": "Old." }));
  assert.equal(finding.status, STATUS.warn);
  assert.match(finding.detail, /matches no file here/);
});

test("a live route resolves clean", () => {
  const findings = routing(router(["src/** | js.md"], { "js.md": "No console.log." }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].status, STATUS.ok);
  assert.match(findings[0].detail, /1 route\(s\), all resolved/);
});

test("E10: a rule file with a BOM and CRLF is read, and neither is rewritten", () => {
  const root = router(["src/** | js.md"], { "js.md": "﻿No console.log.\r\nSecond line.\r\n" });
  assert.equal(routing(root)[0].status, STATUS.ok);
  assert.match(readFileSync(join(root, ".kiln", "rules", "js.md"), "utf8"), /\r\n/, "doctor reads; it does not normalise");
});
