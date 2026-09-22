import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  ConfigError,
  DEFAULTS,
  checkSchema,
  deepMerge,
  findRoot,
  integrationBranch,
  loadConfig,
  parseJsonText,
} from "../lib/config.mjs";
import { spawnSync } from "node:child_process";
import { setPath } from "../bin/kiln.mjs";
import { protectedBranchesFor } from "../lib/modules.mjs";
import { cleanupFixtures, commitAll, initRepo, tempRoot, writeConfig, writeFile } from "./helpers/fixture.mjs";

after(cleanupFixtures);

test("B05: a byte-order mark parses instead of reading as a broken config", () => {
  assert.deepEqual(parseJsonText('﻿{"a":1}'), { a: 1 });
});

test("B05: CRLF survives the read untouched", () => {
  const root = tempRoot();
  const path = join(root, ".kiln", "config.json");
  mkdirSync(join(root, ".kiln"), { recursive: true });
  writeFileSync(path, '﻿{\r\n  "artifact_language": "vi"\r\n}\r\n', "utf8");
  assert.equal(loadConfig(root).config.artifact_language, "vi");
});

test("defaults fill every key the file omits", () => {
  const root = tempRoot();
  writeConfig(root, { vcs: { protected: ["v3-master"] } });
  const { config } = loadConfig(root);
  assert.deepEqual(config.vcs.protected, ["v3-master"]);
  assert.equal(config.vcs.branch_pattern, DEFAULTS.vcs.branch_pattern);
  assert.equal(config.work.committed, true);
});

test("D73: there is no verify provider to configure", () => {
  assert.equal("verify" in DEFAULTS, false);
});

test("deepMerge replaces arrays rather than concatenating them", () => {
  assert.deepEqual(deepMerge({ a: [1, 2] }, { a: [3] }), { a: [3] });
});

test("D38: discovery walks up, so a deep cwd finds the workspace root", () => {
  const root = tempRoot();
  writeConfig(root, {});
  const deep = join(root, "AdminPage", "application", "controllers");
  mkdirSync(deep, { recursive: true });
  assert.equal(findRoot(deep), root);
});

test("discovery returns null rather than guessing when there is no config", () => {
  assert.equal(findRoot(tempRoot()), null);
});

test("D39: an older schema migrates in memory and reports that it did", () => {
  const { migrated, foundVersion } = checkSchema(0);
  assert.equal(migrated, true);
  assert.equal(foundVersion, 0);
});

test("D39: a newer schema is refused, and the message carries both numbers", () => {
  assert.throws(() => checkSchema(99), (err) => /99/.test(err.message) && /1/.test(err.message));
});

test("D39: loading never rewrites the file it migrated", () => {
  const root = tempRoot();
  const path = writeConfig(root, { schema_version: 0, artifact_language: "vi" });
  const { migrated, config } = loadConfig(root);

  assert.equal(migrated, true);
  assert.equal(config.schema_version, 1, "the in-memory copy is current");
  assert.equal(parseJsonText(readFileSync(path, "utf8")).schema_version, 0, "the tracked file is not touched");
});

test("a missing config names the fix rather than throwing a parse error", () => {
  assert.throws(() => loadConfig(tempRoot()), ConfigError);
});

test("D81: integration_branch resolves per module and falls back for unlisted ones", () => {
  const mapped = { vcs: { integration_branch: { "admin-page": "v3-master" } } };
  assert.equal(integrationBranch(mapped, "admin-page"), "v3-master");
  assert.equal(integrationBranch(mapped, "common-models"), "main");
});

test("D81: a scalar still answers for every module", () => {
  const scalar = { vcs: { integration_branch: "develop" } };
  assert.equal(integrationBranch(scalar, "anything"), "develop");
});

/**
 * These two assert TERMINATION, which is the bug they were written for: the walk used to
 * converge on "." and never reach its stop condition.
 *
 * They used to assert `null`, which is only true when the working directory happens to
 * have no `.kiln/` above it — so they failed the moment anyone ran `kiln init` on the
 * kiln repository, which is the first thing a contributor does. Found by dogfooding.
 * A test that cannot pass in the repository it ships from is a test about the
 * environment, not about the code.
 */
function terminates(path) {
  const found = findRoot(path);
  assert.notEqual(found, ".", "`.` is where the old walk converged and spun forever");
  assert.ok(found === null || isAbsolute(found), `findRoot returned ${found}`);
}

test("findRoot terminates on a relative path, where parse().root is empty", () => {
  terminates("some/relative/path");
});

test("findRoot terminates on a malformed path rather than spinning", () => {
  terminates(String.fromCharCode(0) + "invalid");
});

test("findRoot returns null when no ancestor holds a config", () => {
  const root = join(tempRoot(), "nested", "deeper");
  assert.equal(findRoot(root), null, "an absolute path is not affected by where the tests run");
});

/**
 * D48 keeps the config out of the agent's reach, which left no way to change a value after
 * init: the guard refuses the edit, init overwrites nothing, and there was no verb — so a
 * user who said "the integration branch is v3-master" was told to edit JSON by hand. That
 * happened three times across three sessions.
 *
 * #68 settled the principle for a per-run flag; this applies it to a durable change. What
 * matters is the direction.
 */
function configured(overrides = {}) {
  const root = initRepo(tempRoot("kiln-configset-"));
  writeFile(join(root, "a.txt"), "a");
  commitAll(root, "first");
  writeConfig(root, {
    ...DEFAULTS,
    vcs: { ...DEFAULTS.vcs, integration_branch: "v3-develop", protected: ["master", "v3-master", "v3-develop"] },
    stack: { id: "node", cmd: { test: "true" }, steps: [{ id: "unit", run: "${cmd.test}" }] },
    ...overrides,
  });
  writeFile(join(root, ".kiln", "rules", "index.md"), "# rules\n");
  return root;
}

const cli = (root, args) => spawnSync(process.execPath, [new URL("../bin/kiln.mjs", import.meta.url).pathname, ...args], { cwd: root, encoding: "utf8" });
const onDisk = (root) => JSON.parse(readFileSync(join(root, ".kiln", "config.json"), "utf8"));

test("config set re-aims enforcement and says what changed", () => {
  const root = configured();
  const run = cli(root, ["config", "set", "vcs.integration_branch=v3-master"]);

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /vcs\.integration_branch: "v3-develop" → "v3-master"/);
  assert.equal(onDisk(root).vcs.integration_branch, "v3-master");
});

test("config set refuses to stop protecting a branch", () => {
  const root = configured();
  const run = cli(root, ["config", "set", "vcs.protected=v3-master"]);

  assert.equal(run.status, 2);
  assert.match(run.stderr, /stop protecting master/);
  assert.match(run.stderr, /never loosen it/);
  assert.deepEqual(onDisk(root).vcs.protected, ["master", "v3-master", "v3-develop"], "and writes nothing");
});

test("config set refuses to hand the gates to auto mode", () => {
  const root = configured();
  const run = cli(root, ["config", "set", "auto.bounded=true"]);

  assert.equal(run.status, 2);
  assert.match(run.stderr, /stays your own edit/);
  assert.equal(onDisk(root).auto.bounded, false);
});

test("adding a protected branch is a tightening, so it is allowed", () => {
  const root = configured();
  assert.equal(cli(root, ["config", "set", "vcs.protected=master,v3-master,v3-develop,main"]).status, 0);
  assert.ok(onDisk(root).vcs.protected.includes("main"));
});

/**
 * `--set` after the file exists was read and dropped in silence, and the run still printed
 * "kiln decided these for you" listing defaults that were not what the file held.
 */
test("init refuses --set on a project it will not overwrite, and describes no proposal", () => {
  const root = configured();
  const run = cli(root, ["init", "--set", "vcs.integration_branch=v3-master"]);

  assert.equal(run.status, 1);
  assert.match(run.stderr, /would be read and dropped/);
  assert.match(run.stderr, /kiln config set/);
  assert.equal(onDisk(root).vcs.integration_branch, "v3-develop");

  const plain = cli(root, ["init"]);
  assert.doesNotMatch(plain.stdout, /kiln decided these for you/, "the file on disk is not a proposal");
});

/**
 * `--set vcs.protected=v3-master` stored the string, `protectedBranchesFor` spread it into
 * ["v","3","-","m",…], and a push to v3-master was ALLOWED — D7 item 1, defeated through the
 * documented flag, on a project with exactly one protected branch.
 */
test("a value takes the shape already at its key", () => {
  const draft = { vcs: { protected: ["main"], integration_branch: "main" }, auto: { bounded: false }, rules: { budget_lines: 200 } };

  setPath(draft, "vcs.protected=v3-master");
  assert.deepEqual(draft.vcs.protected, ["v3-master"], "one branch is still a list");

  setPath(draft, "vcs.protected=master, v3-master ,v3-develop");
  assert.deepEqual(draft.vcs.protected, ["master", "v3-master", "v3-develop"], "and several are trimmed");

  setPath(draft, "auto.bounded=true");
  assert.equal(draft.auto.bounded, true, "`\"true\"` is not true, and autoEligible compares with ===");

  setPath(draft, "rules.budget_lines=400");
  assert.equal(draft.rules.budget_lines, 400);

  setPath(draft, "vcs.integration_branch=v3-develop");
  assert.equal(draft.vcs.integration_branch, "v3-develop", "a string stays a string");
});

/**
 * Measured: an agent set a two-step list with `--set stack.steps=[{...},{...}]` and kiln
 * split it on the commas inside the JSON, writing six string fragments into a real
 * project's .kiln/config.json. Repairing it took `node -e` — a direct write to the file
 * D48 exists to keep out of the agent's reach.
 */
test("a value written as JSON is stored as JSON", () => {
  const draft = { stack: { steps: [{ id: "unit", run: "${cmd.test}" }] } };
  setPath(draft, 'stack.steps=[{"id":"unit-fast","phase":"fast","run":"make fast"},{"id":"unit","phase":"full","run":"make test"}]');

  assert.deepEqual(draft.stack.steps, [
    { id: "unit-fast", phase: "fast", run: "make fast" },
    { id: "unit", phase: "full", run: "make test" },
  ]);
});

/** Falling back to the comma split is exactly how the corrupt file was written. */
test("JSON that does not parse is refused, not shredded", () => {
  const draft = { stack: { steps: [] } };
  assert.throws(
    () => setPath(draft, 'stack.steps=[{"id":"unit-fast",]'),
    /read it as JSON, and it does not parse/,
  );
  assert.deepEqual(draft.stack.steps, [], "nothing was written");
});

test("only a structure declares itself with a bracket", () => {
  const draft = { vcs: { branch_pattern: "${id}" }, stack: { cmd: { test: "npm test" } } };
  setPath(draft, "vcs.branch_pattern=feature/v3/${id}");
  assert.equal(draft.vcs.branch_pattern, "feature/v3/${id}", "a brace inside the value is not a JSON opening");

  setPath(draft, "stack.cmd.test=make test NO_DUMP=1");
  assert.equal(draft.stack.cmd.test, "make test NO_DUMP=1");
});

test("one protected branch protects that branch", () => {
  const root = configured({ vcs: { protected: ["main"], integration_branch: "main", provider: "github", branch_pattern: "${id}" } });
  assert.equal(cli(root, ["config", "set", "vcs.protected=v3-master,main"]).status, 0);

  assert.deepEqual(protectedBranchesFor(onDisk(root)).sort(), ["main", "v3-master"]);
});
