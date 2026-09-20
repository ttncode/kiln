import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { DEFAULTS, loadConfig } from "../lib/config.mjs";
import { STATUS, runChecks, worstStatus } from "../lib/doctor.mjs";
import { newWork, statePath, writeState } from "../lib/state.mjs";
import { cleanupFixtures, tempRoot, writeConfig, writeFile } from "./helpers/fixture.mjs";

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
  writeFile(join(root, ".kiln", "rules", "index.md"), "| `src/**` | routed.md |\n");
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
