import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  AUTHORIZING,
  GATE_KEYS,
  SHIP_AUTHORIZING,
  STATUS,
  StateError,
  hashArtifact,
  isStaleVerify,
  newWork,
  readState,
  recordFullVerified,
  recordGate,
  recordVerify,
  workDir,
  writeState,
} from "../lib/state.mjs";
import { cleanupFixtures, tempRoot, writeFile } from "./helpers/fixture.mjs";

after(cleanupFixtures);

const seed = () => newWork({ id: "42", sessionId: "s-1", base: "aaaa111" });

test("D49: the gate keys are fixed and total", () => {
  assert.deepEqual(GATE_KEYS, ["probe", "spec", "plan", "review", "ship"]);
});

test("D49: exactly one gate per path unlocks source edits", () => {
  assert.deepEqual(AUTHORIZING, { spike: "probe", bounded: "plan", full: "plan" });
});

test("D77: no gate can authorize shipping a spike", () => {
  assert.equal(SHIP_AUTHORIZING.spike, null);
  assert.equal(SHIP_AUTHORIZING.bounded, "review", "a bounded review accept is accept-and-ship");
  assert.equal(SHIP_AUTHORIZING.full, "ship");
});

test("a new work starts with nothing approved", () => {
  const state = seed();
  assert.deepEqual(state.gates, {});
  assert.deepEqual(state.predicted, []);
  assert.equal(state.pass, 1);
  assert.equal(state.status, STATUS.inProgress);
  assert.equal(state.last_verified, state.base, "D76: the anchor starts at base");
});

test("§3c: writes are atomic, so a reader never sees a half-file", () => {
  const root = tempRoot();
  writeState(root, seed());
  const entries = readdirSync(workDir(root, "42"));
  assert.deepEqual(entries, ["state.json"], "no staging file is left behind");
  assert.equal(readState(root, "42").id, "42");
});

test("D65: the gate record hashes the artifact itself", () => {
  const plan = writeFile(`${tempRoot()}/plan.md`, "# the plan\n");
  const state = recordGate(seed(), { key: "plan", decision: "approved", artifactPath: plan, answer: "yes, go" });

  assert.equal(state.gates.plan.artifact_sha, hashArtifact(plan));
  assert.equal(state.gates.plan.answer, "yes, go", "the user's words are kept verbatim");
  assert.equal(state.gates.plan.by, "user");
});

test("D65: editing the approved artifact breaks the binding", () => {
  const plan = writeFile(`${tempRoot()}/plan.md`, "# the plan\n");
  const state = recordGate(seed(), { key: "plan", decision: "approved", artifactPath: plan, answer: "yes" });

  writeFile(plan, "# the plan, quietly rewritten\n");
  assert.notEqual(state.gates.plan.artifact_sha, hashArtifact(plan));
});

test("an unknown gate key is refused rather than stored", () => {
  assert.throws(() => recordGate(seed(), { key: "deploy", decision: "approved" }), StateError);
});

test("D16: an auto-ruled gate records that nobody was asked", () => {
  const state = recordGate(seed(), { key: "review", decision: "accepted", answer: "2 Minor, both fixed", by: "auto" });
  assert.equal(state.gates.review.by, "auto");
  assert.equal(state.gates.review.artifact_sha, null);
});

test("a follow-up work names the one it follows and inherits none of its approvals", () => {
  const next = newWork({ id: "42.2", sessionId: "s", base: "bbbb222", follows: "42" });
  assert.equal(next.follows, "42");
  assert.deepEqual(next.gates, {});
  assert.deepEqual(next.predicted, []);
  assert.equal(next.base, "bbbb222");
});

test("D29: verify entries record the exit code, never a reading of stdout", () => {
  const entry = { id: "unit", cmd: "npm test", exit: 1, ms: 120, range: "aaaa111..bbbb222" };
  const state = recordVerify(seed(), entry);
  assert.equal(state.verify[0].exit, 1);
});

test("an entry from another range, or another tree, is stale, not evidence", () => {
  const entry = { id: "unit", exit: 0, range: "aaaa111..bbbb222", tree: "t1" };
  assert.equal(isStaleVerify(entry, { range: "aaaa111..bbbb222", tree: "t1" }), false);
  assert.equal(isStaleVerify(entry, { range: "aaaa111..cccc333", tree: "t1" }), true, "a new commit");
  assert.equal(isStaleVerify(entry, { range: "aaaa111..bbbb222", tree: "t2" }), true, "an uncommitted edit");
  assert.equal(isStaleVerify({ id: "unit", exit: 0, range: "aaaa111..bbbb222" }, { range: "aaaa111..bbbb222", tree: "t1" }), true, "a record naming no tree");
});

test("D76: only a green full phase advances the anchor", () => {
  const advanced = recordFullVerified(seed(), "cccc333");
  assert.equal(advanced.last_verified, "cccc333");
  assert.equal(advanced.base, "aaaa111", "base is immutable provenance");
});

test("every transition returns a new object rather than mutating its input", () => {
  const before = seed();
  const snapshot = JSON.stringify(before);
  recordGate(before, { key: "plan", decision: "approved", answer: "y" });
  recordVerify(before, { id: "unit", exit: 0 });
  assert.equal(JSON.stringify(before), snapshot);
});

test("state round-trips through disk unchanged", () => {
  const root = tempRoot();
  const state = recordVerify(seed(), { id: "unit", cmd: "npm test", exit: 0, ms: 9, range: "a..b" });
  const path = writeState(root, state);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), state);
});
