/**
 * Unit-level coverage for the two guards. The promise they serve, and its proof, live
 * together in tests/d7.test.mjs; this file is the detail underneath it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { destructiveTargets, opensPullRequest, writeTargets } from "../lib/guards/bash-targets.mjs";
import { dispatch } from "../hooks/dispatch.mjs";
import { newWork, writeState } from "../lib/state.mjs";
import { cleanupFixtures } from "./helpers/fixture.mjs";
import { kilnProject, payload } from "./helpers/project.mjs";

after(cleanupFixtures);

const BLOCK = 2;
const ALLOW = 0;

const bash = async (command, project, session) =>
  dispatch("pre-bash", payload({ command, root: project.root, session }));
const edit = async (file, project, session) =>
  dispatch("pre-edit", payload({ file, root: project.root, session }));

// ---------------------------------------------------------------- bash targets

test("D64: the verbs a blocked agent actually reaches for are seen", async () => {
  assert.deepEqual(writeTargets('echo "hello" > src/a.ts'), ["src/a.ts"]);
  assert.deepEqual(writeTargets("cat x >> src/a.ts"), ["src/a.ts"]);
  assert.deepEqual(writeTargets("sed -i s/a/b/ src/a.ts"), ["src/a.ts"]);
  assert.deepEqual(writeTargets("cp /tmp/x src/a.ts"), ["src/a.ts"]);
  assert.deepEqual(writeTargets("mv /tmp/x src/a.ts"), ["src/a.ts"]);
  assert.deepEqual(writeTargets("tee src/a.ts"), ["src/a.ts"]);
});

test("B25: the ceiling is asserted, not claimed closed", async () => {
  assert.deepEqual(writeTargets("python -c \"open('src/a.ts','w')\""), [], "interpreters are uncovered, by decision");
  assert.deepEqual(writeTargets("bash <<'EOF'\ncode\nEOF"), [], "heredocs are uncovered, by decision");
});

test("D34: only rm -rf and git clean -xfd count as destructive", async () => {
  assert.deepEqual(destructiveTargets("rm -rf /home/you/data"), ["/home/you/data"]);
  assert.deepEqual(destructiveTargets("rm -fr build"), ["build"]);
  assert.deepEqual(destructiveTargets("rm file.txt"), [], "a plain rm stays with the harness prompt");
  assert.deepEqual(destructiveTargets("git clean -xfd"), ["."]);
});

test("D77: PR creation is matched by command name, not by parsing a shell", async () => {
  assert.equal(opensPullRequest("gh pr create --fill"), true);
  assert.equal(opensPullRequest("glab mr create"), true);
  assert.equal(opensPullRequest("gh pr view 4"), false);
  assert.equal(opensPullRequest("npm test"), false);
});

test("D33: kiln does not police a session it is not driving", async () => {
  const project = kilnProject({ gates: {} });
  assert.equal(await edit(project.source, project, "a-different-session"), ALLOW);
});

// ---------------------------------------------------------------- D64, the bash hole

test("D64: a shell redirect into source obeys the same gate as Write", async () => {
  const before = kilnProject({ gates: {} });
  assert.equal(await bash('echo "x" > src/app.ts', before), BLOCK, "the measured first retry of a blocked agent");

  const after = kilnProject({ gates: { plan: "approved" } });
  assert.equal(await bash('echo "x" > src/app.ts', after), ALLOW);
});

test("D64: sed -i and cp into source are the same question", async () => {
  const project = kilnProject({ gates: {} });
  assert.equal(await bash("sed -i s/a/b/ src/app.ts", project), BLOCK);
  assert.equal(await bash("cp /tmp/x src/app.ts", project), BLOCK);
});

// ---------------------------------------------------------------- D77, shipping

test("D77: a spike can never open a pull request", async () => {
  const project = kilnProject({ path: "spike", gates: { probe: "approved" } });
  assert.equal(await bash("gh pr create --fill", project), BLOCK);
});

test("D77: on full, the ship gate is enforced rather than prompted", async () => {
  const unapproved = kilnProject({ path: "full", gates: { plan: "approved" } });
  assert.equal(await bash("gh pr create --fill", unapproved), BLOCK);

  const approved = kilnProject({ path: "full", gates: { plan: "approved", ship: "approved" } });
  assert.equal(await bash("gh pr create --fill", approved), ALLOW);
});

test("D77: on bounded, the review accept is what authorizes the PR", async () => {
  const reviewed = kilnProject({ path: "bounded", gates: { plan: "approved", review: "approved" } });
  assert.equal(await bash("gh pr create --fill", reviewed), ALLOW);

  const notYet = kilnProject({ path: "bounded", gates: { plan: "approved" } });
  assert.equal(await bash("gh pr create --fill", notYet), BLOCK);
});

test("reading a PR is not opening one", async () => {
  const project = kilnProject({ path: "spike", gates: { probe: "approved" } });
  assert.equal(await bash("gh pr view 4", project), ALLOW);
});

// ---------------------------------------------------------------- D66, ownership

test("D66: a path another active work has claimed is blocked, and the owner is named", async () => {
  const project = kilnProject({ id: "42", gates: { plan: "approved" } });
  writeState(project.root, {
    ...newWork({ id: "99", sessionId: "other-session", base: "bbbb222" }),
    predicted: [{ path: "src/app.ts" }],
  });

  assert.equal(await edit(project.source, project), BLOCK, "work 99 claimed it first");
});

test("D66: disjoint claims run concurrently", async () => {
  const project = kilnProject({ id: "42", gates: { plan: "approved" } });
  writeState(project.root, {
    ...newWork({ id: "99", sessionId: "other-session", base: "bbbb222" }),
    predicted: [{ path: "src/elsewhere.ts" }],
  });

  assert.equal(await edit(project.source, project), ALLOW, "nothing overlaps, so nothing blocks");
});

test("D66: a work does not block itself with its own claim", async () => {
  const project = kilnProject({ id: "42", gates: { plan: "approved" }, predicted: [{ path: "src/app.ts" }] });
  assert.equal(await edit(project.source, project), ALLOW);
});

test("D33: an unreadable state blocks, proved at the process the harness actually runs", async () => {
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
