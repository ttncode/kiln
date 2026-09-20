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
import { adoptSession, newWork, readState, writeState } from "../lib/state.mjs";
import { cleanupFixtures } from "./helpers/fixture.mjs";
import { SESSION, kilnProject, payload } from "./helpers/project.mjs";

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

test("D43: a heredoc body is data, so a markdown blockquote is not a redirect", () => {
  const heredoc = `cat > .kiln/work/42/plan.md <<'EOF'\n# Plan\n\n> Recommendation: approve.\n\n- modify bin/kiln.mjs\nEOF`;

  assert.deepEqual(writeTargets(heredoc), [".kiln/work/42/plan.md"], "the blockquote is prose, not a shell verb");
});

test("D43: writing the plan does not block on the plan gate", async () => {
  const project = kilnProject({ gates: {} });
  const plan = join(project.root, ".kiln", "work", "42", "plan.md");
  const command = `cat > ${plan} <<'EOF'\n> Recommendation: approve. See src/app.ts.\nEOF`;

  assert.equal(await bash(command, project), ALLOW, "the plan stage cannot deadlock on its own output");
});

test("a heredoc still cannot smuggle a source edit past the gate", async () => {
  const project = kilnProject({ gates: {} });
  const command = `cat > ${join(project.root, "src", "app.ts")} <<'EOF'\nexport const a = 2;\nEOF`;

  assert.equal(await bash(command, project), BLOCK, "the redirect target is still read");
});

// ---------------------------------------------------------------- D66, handover

test("D66: a second session takes the work over, out loud", () => {
  const project = kilnProject({ gates: { plan: "approved" } });
  const adopted = adoptSession(readState(project.root, "42"), "second-session");

  assert.equal(adopted.session_id, "second-session");
  assert.deepEqual(adopted.displaced, [SESSION], "the session it replaced is remembered");
});

test("D66: re-opening in the same session changes nothing", () => {
  const project = kilnProject({ gates: { plan: "approved" } });
  const state = readState(project.root, "42");

  assert.deepEqual(adoptSession(state, SESSION), state, "a resume is not a handover");
});

test("D66: the displaced session is blocked, not quietly allowed", async () => {
  const project = kilnProject({ gates: { plan: "approved" } });
  assert.equal(await edit(project.source, project), ALLOW, "this session owns the work");

  writeState(project.root, adoptSession(readState(project.root, "42"), "second-session"));

  assert.equal(await edit(project.source, project), BLOCK, "its guards would otherwise be silently off");
  assert.equal(await edit(project.source, project, "second-session"), ALLOW, "the session that took over may work");
});

test("D33: a session kiln never drove is still allowed, which is the branch D66 must not break", async () => {
  const project = kilnProject({ gates: {} });
  assert.equal(await edit(project.source, project, "a-session-kiln-never-saw"), ALLOW);
});

// ---------------------------------------------------------------- sed grammar

test("a quoted sed script is one argument, not two phantom paths", () => {
  assert.deepEqual(writeTargets("sed -i '$a\\// a' lib/work.mjs"), ["lib/work.mjs"]);
  assert.deepEqual(writeTargets("sed -i -e '$a// a' lib/work.mjs"), ["lib/work.mjs"], "-e carries the script");
  assert.deepEqual(writeTargets("sed -i s#a#b# src/app.ts"), ["src/app.ts"], "any delimiter");
});

test("the sed file operand is still seen, so the gate still applies to it", async () => {
  const project = kilnProject({ gates: {} });
  assert.equal(await bash("sed -i '$a\\// note' src/app.ts", project), BLOCK);
});
