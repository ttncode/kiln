import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { destructiveTargets, opensPullRequest, writeTargets } from "../lib/guards/bash-targets.mjs";
import { dispatch } from "../hooks/dispatch.mjs";
import { newWork, openNextPass, readState, writeState } from "../lib/state.mjs";
import { cleanupFixtures } from "./helpers/fixture.mjs";
import { kilnProject, payload } from "./helpers/project.mjs";

after(cleanupFixtures);

const BLOCK = 2;
const ALLOW = 0;

const bash = (command, project, session) =>
  dispatch("pre-bash", payload({ command, root: project.root, session }));
const edit = (file, project, session) =>
  dispatch("pre-edit", payload({ file, root: project.root, session }));

// ---------------------------------------------------------------- bash targets

test("D64: the verbs a blocked agent actually reaches for are seen", () => {
  assert.deepEqual(writeTargets('echo "hello" > src/a.ts'), ["src/a.ts"]);
  assert.deepEqual(writeTargets("cat x >> src/a.ts"), ["src/a.ts"]);
  assert.deepEqual(writeTargets("sed -i s/a/b/ src/a.ts"), ["src/a.ts"]);
  assert.deepEqual(writeTargets("cp /tmp/x src/a.ts"), ["src/a.ts"]);
  assert.deepEqual(writeTargets("mv /tmp/x src/a.ts"), ["src/a.ts"]);
  assert.deepEqual(writeTargets("tee src/a.ts"), ["src/a.ts"]);
});

test("B25: the ceiling is asserted, not claimed closed", () => {
  assert.deepEqual(writeTargets("python -c \"open('src/a.ts','w')\""), [], "interpreters are uncovered, by decision");
  assert.deepEqual(writeTargets("bash <<'EOF'\ncode\nEOF"), [], "heredocs are uncovered, by decision");
});

test("D34: only rm -rf and git clean -xfd count as destructive", () => {
  assert.deepEqual(destructiveTargets("rm -rf /home/you/data"), ["/home/you/data"]);
  assert.deepEqual(destructiveTargets("rm -fr build"), ["build"]);
  assert.deepEqual(destructiveTargets("rm file.txt"), [], "a plain rm stays with the harness prompt");
  assert.deepEqual(destructiveTargets("git clean -xfd"), ["."]);
});

test("D77: PR creation is matched by command name, not by parsing a shell", () => {
  assert.equal(opensPullRequest("gh pr create --fill"), true);
  assert.equal(opensPullRequest("glab mr create"), true);
  assert.equal(opensPullRequest("gh pr view 4"), false);
  assert.equal(opensPullRequest("npm test"), false);
});

// ---------------------------------------------------------------- D7 item 7

test("A7 / D48: the agent cannot edit the files its guards read", () => {
  const project = kilnProject({ gates: { plan: "approved" } });
  assert.equal(edit(join(project.root, ".kiln", "work", "42", "state.json"), project), BLOCK);
  assert.equal(edit(join(project.root, ".kiln", "config.json"), project), BLOCK);
  assert.equal(edit(project.artifacts.plan, project), ALLOW, "artifacts stay writable");
});

test("A7: the control-file block does not depend on kiln driving the session", () => {
  const project = kilnProject();
  const verdict = edit(join(project.root, ".kiln", "config.json"), project, "some-other-session");
  assert.equal(verdict, BLOCK, "an emptied vcs.protected outlives the run that emptied it");
});

// ---------------------------------------------------------------- D7 item 5

test("A5: another work's directory is not this work's to write", () => {
  const project = kilnProject({ gates: { plan: "approved" } });
  assert.equal(edit(join(project.root, ".kiln", "work", "99", "plan.md"), project), BLOCK);
});

test("A5: outside the project root is blocked, inside is not", () => {
  const project = kilnProject({ gates: { plan: "approved" } });
  assert.equal(edit("/tmp/somewhere-else.txt", project), BLOCK);
  assert.equal(edit(project.source, project), ALLOW);
});

// ---------------------------------------------------------------- D7 item 2

test("A2: rm -rf outside the repo is blocked, inside it is not", () => {
  const project = kilnProject({ gates: { plan: "approved" } });
  assert.equal(bash("rm -rf /tmp/not-my-repo", project), BLOCK);
  assert.equal(bash("rm -rf build", project), ALLOW);
});

// ---------------------------------------------------------------- D7 item 4

test("A4: a source edit before the plan gate is blocked", () => {
  const project = kilnProject({ gates: {} });
  assert.equal(edit(project.source, project), BLOCK);
});

test("A4: a source edit after the plan gate is allowed", () => {
  const project = kilnProject({ gates: { plan: "approved" } });
  assert.equal(edit(project.source, project), ALLOW);
});

test("A4: a halted work blocks source edits immediately", () => {
  const project = kilnProject({ gates: { plan: "approved" } });
  writeState(project.root, { ...readState(project.root, "42"), status: "halted" });
  assert.equal(edit(project.source, project), BLOCK);
});

test("A4 / D65: approving a plan and then editing it blocks the next source write", () => {
  const project = kilnProject({ gates: { plan: "approved" } });
  assert.equal(edit(project.source, project), ALLOW);

  writeFileSync(project.artifacts.plan, "# plan, quietly rewritten\n", "utf8");
  assert.equal(edit(project.source, project), BLOCK, "the approval was for the document they read");
});

test("A4 / D85: a new pass does not inherit the previous pass's approval", () => {
  const project = kilnProject({ gates: { plan: "approved" } });
  assert.equal(edit(project.source, project), ALLOW);

  writeState(project.root, openNextPass(readState(project.root, "42"), "bbbb222"));
  assert.equal(edit(project.source, project), BLOCK, "the artifact is unchanged, and that is the failure");
});

test("D33: kiln does not police a session it is not driving", () => {
  const project = kilnProject({ gates: {} });
  assert.equal(edit(project.source, project, "a-different-session"), ALLOW);
});

// ---------------------------------------------------------------- D64, the bash hole

test("D64: a shell redirect into source obeys the same gate as Write", () => {
  const before = kilnProject({ gates: {} });
  assert.equal(bash('echo "x" > src/app.ts', before), BLOCK, "the measured first retry of a blocked agent");

  const after = kilnProject({ gates: { plan: "approved" } });
  assert.equal(bash('echo "x" > src/app.ts', after), ALLOW);
});

test("D64: sed -i and cp into source are the same question", () => {
  const project = kilnProject({ gates: {} });
  assert.equal(bash("sed -i s/a/b/ src/app.ts", project), BLOCK);
  assert.equal(bash("cp /tmp/x src/app.ts", project), BLOCK);
});

// ---------------------------------------------------------------- D77, shipping

test("D77: a spike can never open a pull request", () => {
  const project = kilnProject({ path: "spike", gates: { probe: "approved" } });
  assert.equal(bash("gh pr create --fill", project), BLOCK);
});

test("D77: on full, the ship gate is enforced rather than prompted", () => {
  const unapproved = kilnProject({ path: "full", gates: { plan: "approved" } });
  assert.equal(bash("gh pr create --fill", unapproved), BLOCK);

  const approved = kilnProject({ path: "full", gates: { plan: "approved", ship: "approved" } });
  assert.equal(bash("gh pr create --fill", approved), ALLOW);
});

test("D77: on bounded, the review accept is what authorizes the PR", () => {
  const reviewed = kilnProject({ path: "bounded", gates: { plan: "approved", review: "approved" } });
  assert.equal(bash("gh pr create --fill", reviewed), ALLOW);

  const notYet = kilnProject({ path: "bounded", gates: { plan: "approved" } });
  assert.equal(bash("gh pr create --fill", notYet), BLOCK);
});

test("reading a PR is not opening one", () => {
  const project = kilnProject({ path: "spike", gates: { probe: "approved" } });
  assert.equal(bash("gh pr view 4", project), ALLOW);
});

// ---------------------------------------------------------------- D66, ownership

test("D66: a path another active work has claimed is blocked, and the owner is named", () => {
  const project = kilnProject({ id: "42", gates: { plan: "approved" } });
  writeState(project.root, {
    ...newWork({ id: "99", sessionId: "other-session", base: "bbbb222" }),
    predicted: [{ path: "src/app.ts" }],
  });

  assert.equal(edit(project.source, project), BLOCK, "work 99 claimed it first");
});

test("D66: disjoint claims run concurrently", () => {
  const project = kilnProject({ id: "42", gates: { plan: "approved" } });
  writeState(project.root, {
    ...newWork({ id: "99", sessionId: "other-session", base: "bbbb222" }),
    predicted: [{ path: "src/elsewhere.ts" }],
  });

  assert.equal(edit(project.source, project), ALLOW, "nothing overlaps, so nothing blocks");
});

test("D66: a work does not block itself with its own claim", () => {
  const project = kilnProject({ id: "42", gates: { plan: "approved" }, predicted: [{ path: "src/app.ts" }] });
  assert.equal(edit(project.source, project), ALLOW);
});

test("D33: an unreadable state blocks, proved at the process the harness actually runs", () => {
  const project = kilnProject({ gates: { plan: "approved" } });
  writeFileSync(join(project.root, ".kiln", "work", "42", "state.json"), "{ not json", "utf8");

  const dispatcher = new URL("../hooks/dispatch.mjs", import.meta.url).pathname;
  const run = spawnSync(process.execPath, [dispatcher, "pre-edit"], {
    input: JSON.stringify(payload({ file: project.source, root: project.root })),
    encoding: "utf8",
  });

  assert.equal(run.status, BLOCK, "unreadable is not absent");
  assert.match(run.stderr, /cannot be read/);
});
