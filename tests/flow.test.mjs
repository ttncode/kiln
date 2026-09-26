/**
 * The run as a sequence, end to end through the real binary: the places where two correct
 * decisions met and produced a wrong run. Each test is a path a real agent takes.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupFixtures, commitAll, writeConfig, writeFile } from "./helpers/fixture.mjs";
import { DEFAULTS } from "../lib/config.mjs";
import { SESSION, kiln, monorepo, nodeProject, ok, state, throughPlanGate, writeReview } from "./helpers/journey.mjs";
import { judge } from "./helpers/hook.mjs";

after(cleanupFixtures);

const DENY = 2;
const ALLOW = 0;
const APPROVE = "1. Approve this as written (recommended)";
const edit = (root, file) => judge("pre-edit", { session_id: SESSION, cwd: root, tool_input: { file_path: join(root, file) } });

function reviewed(root, id) {
  writeReview(root, id);
  return ok(root, ["gate", id, "review", "--answer", APPROVE]);
}

test("the gate hashes the document its key names, whether or not the caller names it", async () => {
  const root = nodeProject({ name: "derived" });
  ok(root, ["open", "w1", "--session", SESSION]);

  const missing = kiln(root, ["gate", "w1", "plan", "--answer", APPROVE]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /plan\.md, which does not exist yet/);

  writeFile(join(root, ".kiln", "work", "w1", "plan.md"), "# plan\n");
  const elsewhere = kiln(root, ["gate", "w1", "plan", "--artifact", "README.md", "--answer", APPROVE]);
  assert.equal(elsewhere.status, 2, "a record hashed from another file would bind to the wrong document");

  ok(root, ["gate", "w1", "plan", "--answer", APPROVE, "--predicted", "src/app.js"]);
  assert.ok(state(root, "w1").gates.plan.artifact_sha, "no --artifact, and still bound");
  assert.equal((await edit(root, "src/app.js")).status, ALLOW);
  writeFile(join(root, ".kiln", "work", "w1", "plan.md"), "# a different plan\n");
  assert.equal((await edit(root, "src/app.js")).status, DENY, "and the binding holds");
});

test("a pull request is recorded only when the ship-authorising gate allows one", () => {
  const root = nodeProject({ name: "ship-gate" });
  ok(root, ["open", "w1", "--session", SESSION]);
  const early = kiln(root, ["ship", "w1", "--opened", "https://example.invalid/pr/1"]);
  assert.equal(early.status, 2, "no gate at all");
  assert.equal(state(root, "w1").status, "in_progress");

  ok(root, ["open", "sp", "--path", "spike", "--session", "s-spike"]);
  const spike = kiln(root, ["ship", "sp", "--opened", "https://example.invalid/pr/2"]);
  assert.equal(spike.status, 2);
  assert.match(spike.stderr, /does not ship/);

  writeFile(join(root, ".kiln", "work", "w1", "plan.md"), "# plan\n");
  ok(root, ["gate", "w1", "plan", "--answer", APPROVE, "--predicted", "src/app.js"]);
  assert.equal(kiln(root, ["ship", "w1", "--opened", "https://example.invalid/pr/1"]).status, 2, "a plan is not a review");
  reviewed(root, "w1");
  assert.equal(ok(root, ["ship", "w1", "--opened", "https://example.invalid/pr/1"]).status, 0);
  assert.equal(state(root, "w1").status, "shipped");
});

test("after review the run is still guarded: source is refused, the review itself is not", async () => {
  const root = nodeProject({ name: "window" });
  throughPlanGate(root, "w1");
  reviewed(root, "w1");
  assert.equal(state(root, "w1").status, "reviewed");
  const change = await edit(root, "src/app.js");
  assert.equal(change.status, DENY);
  assert.match(change.stderr, /passed its review gate/);
  assert.equal((await edit(root, ".kiln/work/w1/review.md")).status, ALLOW);
  assert.equal((await edit(root, ".kiln/tmp/w1/notes.txt")).status, ALLOW);
});

test("a full run that fails after review sends the work back to implementation, out loud", async () => {
  const root = nodeProject({ name: "reopen", cmd: { test: "exit 1" } });
  throughPlanGate(root, "w1");
  reviewed(root, "w1");

  const failed = kiln(root, ["verify", "w1"]);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /back in implementation/);
  const after = state(root, "w1");
  assert.equal(after.status, "in_progress");
  assert.equal(after.gates.review, undefined, "the change will move, so the review is asked again");
  assert.ok(after.gates.plan, "the plan still stands");
  assert.equal(after.carry_over.at(-1).kind, "verify_failed");
  assert.equal((await edit(root, "src/app.js")).status, ALLOW, "and the fix can be made inside the run");
});

test("committing each task and verifying before review still shows review the change", () => {
  const root = nodeProject({ name: "anchor" });
  throughPlanGate(root, "w1");
  writeFile(join(root, "src", "app.js"), "export const a = 2;\n");
  commitAll(root, "task 1");
  ok(root, ["verify", "w1"]);
  const scope = ok(root, ["scope", "w1"]);
  assert.match(scope.stdout, /actual 1/);
  assert.match(ok(root, ["rules", "w1", "--stage", "review"]).stdout, /./);
});

test("a shipped work is not reopened; its follow-up is a new work with no approvals", async () => {
  const root = nodeProject({ name: "follow" });
  throughPlanGate(root, "w1");
  reviewed(root, "w1");
  ok(root, ["ship", "w1", "--opened", "https://example.invalid/pr/1"]);

  const reopened = kiln(root, ["open", "w1", "--session", "s-next"]);
  assert.equal(reopened.status, 1);
  assert.match(reopened.stderr, /kiln open w1\.2 --follows w1/);

  ok(root, ["open", "w1.2", "--follows", "w1", "--session", "s-next"]);
  assert.equal(state(root, "w1.2").follows, "w1");
  const early = await judge("pre-edit", { session_id: "s-next", cwd: root, tool_input: { file_path: join(root, "src", "app.js") } });
  assert.equal(early.status, DENY, "the first run's approvals were for the first run's change");
  assert.match(ok(root, ["report", "w1.2"]).stdout, /follows w1/);
});

test("a state written by a newer kiln is refused with both numbers", () => {
  const root = nodeProject({ name: "newer" });
  ok(root, ["open", "w1", "--session", SESSION]);
  writeFile(join(root, ".kiln", "work", "w1", "state.json"), JSON.stringify({ ...state(root, "w1"), schema_version: 99 }));
  const run = kiln(root, ["report", "w1"]);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /schema_version 99.*\(1\)/);
});

test("D39: a config from an older kiln is read, said once, and rewritten only on request", () => {
  const root = nodeProject({ name: "older" });
  const path = join(root, ".kiln", "config.json");
  writeFile(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), schema_version: 0 }));
  const listed = ok(root, ["list"]);
  assert.match(listed.stderr, /older kiln \(schema 0\).*kiln doctor --write/);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).schema_version, 0, "never rewritten behind the user's back");
  ok(root, ["doctor", "--write"]);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).schema_version, 1);
});

test("B44: the effect point runs from a node config, the second adapter D61 names", () => {
  const root = nodeProject({
    name: "effect",
    cmd: { test: "true", migrate: "true", smoke: "true" },
    steps: [
      { id: "migrate", run: "${cmd.migrate}", provides: "migrate" },
      { id: "unit", run: "${cmd.test}" },
      { id: "smoke", run: "${cmd.smoke}", requires: ["migrate"] },
    ],
  });
  ok(root, ["open", "w1", "--session", SESSION]);
  assert.match(ok(root, ["verify", "w1"]).stdout, /skip {2}smoke — requires migrate/, "no migration in this change, so the step that needs one is skipped with its reason");
  assert.match(ok(root, ["verify", "w1", "--effects", "migrate"]).stdout, /pass {2}smoke/);
});

test("B56: from inside a submodule, the sandbox is the project, not the checkout the agent stands in", async () => {
  const root = monorepo({ modules: [["admin", "AdminPage", "feature/x"], ["common", "common", "feature/x"]] });
  writeConfig(root, { ...DEFAULTS, stack: { id: "node", cmd: { test: "true" }, steps: [{ id: "unit", run: "${cmd.test}" }] } });
  throughPlanGate(root, "w1", { predicted: "common/src/User.php" });
  const inside = join(root, "AdminPage");
  const sibling = await judge("pre-edit", { session_id: SESSION, cwd: inside, tool_input: { file_path: join(root, "common", "src", "User.php") } });
  assert.equal(sibling.status, ALLOW, "a sibling checkout is inside the project");
  const away = await judge("pre-edit", { session_id: SESSION, cwd: inside, tool_input: { file_path: join(root, "..", "elsewhere.txt") } });
  assert.equal(away.status, DENY);
  assert.match(away.stderr, /outside the project root/);
});

test("committing exactly what was verified keeps the run as evidence", () => {
  const root = nodeProject({ name: "commit-after-verify" });
  throughPlanGate(root, "w1");
  writeFile(join(root, "src", "app.js"), "export const a = 2;\n");
  ok(root, ["verify", "w1"]);
  commitAll(root, "the change, as verified");
  assert.match(ok(root, ["report", "w1"]).stdout, /Verified: green, and the run describes the tree as it is now/, "SHIP commits after VERIFY by design");
});

test("on the full path too, the review gate closes source and a failed VERIFY reopens it", async () => {
  const root = nodeProject({ name: "full-reopen", cmd: { test: "exit 1" } });
  ok(root, ["open", "w1", "--path", "full", "--session", SESSION]);
  for (const key of ["spec", "plan"]) {
    writeFile(join(root, ".kiln", "work", "w1", `${key}.md`), `# ${key}\n`);
    ok(root, ["gate", "w1", key, "--answer", APPROVE, ...(key === "plan" ? ["--predicted", "src/app.js"] : [])]);
  }
  reviewed(root, "w1");
  assert.equal(state(root, "w1").status, "reviewed");
  assert.equal((await edit(root, "src/app.js")).status, DENY);
  assert.equal(kiln(root, ["verify", "w1"]).status, 1);
  assert.equal(state(root, "w1").status, "in_progress");
  assert.equal(state(root, "w1").gates.review, undefined);
});

test("an uncommitted edit inside a submodule makes an earlier run stale", () => {
  const root = monorepo({ modules: [["admin", "AdminPage", "feature/x"]] });
  writeConfig(root, { ...DEFAULTS, stack: { id: "node", cmd: { test: "true" }, steps: [{ id: "unit", run: "${cmd.test}" }] } });
  throughPlanGate(root, "w1", { predicted: "AdminPage/src/User.php" });
  ok(root, ["verify", "w1"]);
  assert.match(ok(root, ["report", "w1"]).stdout, /describes the tree as it is now/);
  writeFile(join(root, "AdminPage", "src", "User.php"), "<?php // changed\n");
  assert.match(ok(root, ["report", "w1"]).stdout, /tree has changed since/);
});

/**
 * D47 gave tier 0 one observable — does its output lead to action — and INVESTIGATE never
 * called it: the knowledge port had a consumer only after the plan existed. `--for <id>`
 * records what the blast radius named, and the report says how much of the real change it
 * covered. That number is the bar a richer knowledge tier has to clear.
 */
test("a blast radius asked for a work is recorded, and the report measures it against the change", () => {
  const root = nodeProject({ name: "blast-measure" });
  writeFile(join(root, "src", "export.js"), "export function exportCsv() {}\n");
  writeFile(join(root, "src", "unrelated.js"), "export const x = 1;\n");
  commitAll(root, "files");
  throughPlanGate(root, "w1", { predicted: "src/export.js" });

  const blast = ok(root, ["blast", "--for", "w1", "exportCsv"]);
  assert.match(blast.stdout, /src\/export\.js/);
  assert.deepEqual(state(root, "w1").knowledge, [{ tier: 0, terms: ["exportCsv"], files: ["src/export.js"] }]);

  writeFile(join(root, "src", "export.js"), "export function exportCsv() { return 1; }\n");
  writeFile(join(root, "src", "unrelated.js"), "export const x = 2;\n");
  assert.match(ok(root, ["report", "w1"]).stdout, /Blast radius \(tier 0\): named 1 file\(s\); 1 of the 2 changed were among them/);
  assert.match(ok(root, ["scope", "w1"]).stdout, /Blast radius \(tier 0\): named 1 file\(s\); 1 of the 2 changed were among them/);
});

test("a blast radius asked for no work records nothing, as before", () => {
  const root = nodeProject({ name: "blast-plain" });
  assert.equal(kiln(root, ["blast", "anything"]).status, 0);
});
