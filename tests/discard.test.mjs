/**
 * D205: the discard guard holds for every session while any work is open, and its remedy
 * depends on whose work it is.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cleanupFixtures, git } from "./helpers/fixture.mjs";
import { SESSION, nodeProject, ok, throughPlanGate, writeReview } from "./helpers/journey.mjs";
import { judge } from "./helpers/hook.mjs";

after(cleanupFixtures);

const bash = (root, { command, session = SESSION }) => judge("pre-bash", { session_id: session, cwd: root, tool_input: { command } });

test("D205: another session's open work is protected too, and discarding it is the user's call", async () => {
  const root = nodeProject({ name: "discard-other" });
  ok(root, ["open", "w1", "--session", SESSION]);
  const verdict = await bash(root, { command: "git checkout .", session: "another-session" });
  assert.equal(verdict.status, 2);
  assert.match(verdict.stderr, /work w1 \(in_progress\)[\s\S]*the user's decision, in their own terminal/);
  assert.doesNotMatch(verdict.stderr, /kiln close/, "closing disarms the guard, so it is never offered");
});

test("D205: after the review gate the change is the reviewed one, so only the user may discard it", async () => {
  const root = nodeProject({ name: "discard-reviewed" });
  throughPlanGate(root, "w1");
  writeReview(root, "w1");
  ok(root, ["gate", "w1", "review", "--answer", "1. Approve this as written (recommended)"]);
  const verdict = await bash(root, { command: "git restore src/app.js" });
  assert.equal(verdict.status, 2);
  assert.match(verdict.stderr, /work w1 \(reviewed\)[\s\S]*the user's decision/);
});

test("D205: a closed work arms nothing", async () => {
  const root = nodeProject({ name: "discard-closed" });
  git(root, ["checkout", "-q", "-b", "feature/x"]);
  ok(root, ["open", "w1", "--session", SESSION]);
  ok(root, ["close", "w1", "--answer", "abandoned"]);
  assert.equal((await bash(root, { command: "git reset --hard" })).status, 0);
});
