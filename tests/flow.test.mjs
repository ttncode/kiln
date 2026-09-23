/**
 * The run as a sequence, end to end through the real binary: the places where two correct
 * decisions met and produced a wrong run. Each test is a path a real agent takes.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { cleanupFixtures, commitAll, writeFile } from "./helpers/fixture.mjs";
import { SESSION, kiln, nodeProject, ok, state, throughPlanGate } from "./helpers/journey.mjs";
import { judge } from "./helpers/hook.mjs";

after(cleanupFixtures);

const DENY = 2;
const ALLOW = 0;
const APPROVE = "1. Approve this as written (recommended)";
const edit = (root, file) => judge("pre-edit", { session_id: SESSION, cwd: root, tool_input: { file_path: join(root, file) } });

function reviewed(root, id) {
  writeFile(join(root, ".kiln", "work", id, "review.md"), "# review\n");
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
