/**
 * D206: a commit waits for the gate that authorises shipping — none on a spike, `review` on
 * bounded, `ship` on full — and a halted or displaced session commits nothing.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { cleanupFixtures, git, writeFile } from "./helpers/fixture.mjs";
import { SESSION, nodeProject, ok, throughPlanGate, writeReview } from "./helpers/journey.mjs";
import { judge } from "./helpers/hook.mjs";

after(cleanupFixtures);

const APPROVE = "1. Approve this as written (recommended)";
const commit = (root, session = SESSION) => judge("pre-bash", { session_id: session, cwd: root, tool_input: { command: "git commit -m x" } });

function featureProject(name) {
  const root = nodeProject({ name });
  git(root, ["checkout", "-q", "-b", "feature/x"]);
  return root;
}

test("D206: a spike never commits", async () => {
  const root = featureProject("commit-spike");
  ok(root, ["open", "w1", "--path", "spike", "--session", SESSION]);
  const verdict = await commit(root);
  assert.equal(verdict.status, 2);
  assert.match(verdict.stderr, /a spike does not ship/);
});

test("D206: on full, the review gate is not enough — the ship gate authorises the commit", async () => {
  const root = featureProject("commit-full");
  ok(root, ["open", "w1", "--path", "full", "--session", SESSION]);
  for (const key of ["spec", "plan"]) {
    writeFile(join(root, ".kiln", "work", "w1", `${key}.md`), key === "plan" ? "# plan\n\n## Risk flags\n- none\n" : `# ${key}\n`);
    ok(root, ["gate", "w1", key, "--answer", APPROVE, ...(key === "plan" ? ["--predicted", "src/app.js"] : [])]);
  }
  writeReview(root, "w1");
  ok(root, ["gate", "w1", "review", "--answer", APPROVE]);
  assert.equal((await commit(root)).status, 2, "reviewed, not yet authorised to ship");
  ok(root, ["gate", "w1", "ship", "--answer", APPROVE]);
  assert.equal((await commit(root)).status, 0);
});

test("D206: a halted work commits nothing, even after its review gate", async () => {
  const root = featureProject("commit-halted");
  throughPlanGate(root, "w1");
  writeReview(root, "w1");
  ok(root, ["gate", "w1", "review", "--answer", APPROVE]);
  ok(root, ["halt", "w1", "--reason", "waiting on the user"]);
  const verdict = await commit(root);
  assert.equal(verdict.status, 2);
  assert.match(verdict.stderr, /work w1 is halted/);
});

test("D206: a session whose work was taken over commits nothing", async () => {
  const root = featureProject("commit-displaced");
  ok(root, ["open", "w1", "--session", "sess-A"]);
  ok(root, ["open", "w1", "--session", "sess-B"]);
  const verdict = await commit(root, "sess-A");
  assert.equal(verdict.status, 2);
  assert.match(verdict.stderr, /taken over by another session/);
});
