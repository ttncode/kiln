/**
 * Unit-level coverage for the two guards. The promise they serve, and its proof, live
 * together in tests/d7.test.mjs; this file is the detail underneath it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { destructiveTargets, opensPullRequest, writeTargets } from "../lib/guards/bash-targets.mjs";
import { dispatch } from "../hooks/dispatch.mjs";
import { adoptSession, newWork, readState, writeState } from "../lib/state.mjs";
import { cleanupFixtures } from "./helpers/fixture.mjs";
import { SESSION, kilnProject, payload } from "./helpers/project.mjs";

after(cleanupFixtures);

const BLOCK = 2;
const ALLOW = 0;

/** The real dispatcher process, because the message is what the agent reads on stderr. */
function blockMessage(phase, input) {
  const dispatcher = new URL("../hooks/dispatch.mjs", import.meta.url).pathname;
  const run = spawnSync(process.execPath, [dispatcher, phase], { input: JSON.stringify(input), encoding: "utf8" });
  assert.equal(run.status, BLOCK, `expected a block, got ${run.status}: ${run.stdout}${run.stderr}`);
  return run.stderr;
}

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

/**
 * Measured on a real run: a read-only `SELECT ... HAVING COUNT(*) > 1` was refused as a
 * source edit, because the scan read `> 1` as a redirect into a file named `1`. The agent
 * did not route around it, so the fact it was checking stayed unverified and went into the
 * spec as an unknown.
 */
test("a > inside quotes is the tool's argument, not a redirect", async () => {
  const query = 'docker exec db mysql -e "SELECT id, COUNT(*) FROM administrator_maps GROUP BY id HAVING COUNT(*) > 1"';
  assert.deepEqual(writeTargets(query), [], "the shell passes this as one argument");
  assert.deepEqual(writeTargets('psql -c "SELECT * FROM t WHERE n > 5"'), []);
  assert.deepEqual(writeTargets('awk "{ if ($1 > 2) print }" f.txt'), []);
  assert.deepEqual(writeTargets("grep -E 'a>b' file"), []);
  assert.deepEqual(writeTargets('echo "a > b" > real.txt'), ["real.txt"], "the quoted one is data, the bare one is the redirect");
});

/**
 * Splitting on `;` before reading quotes made a real write invisible: the `;` inside
 * `drop_column('users','email');` ended the segment, and the redirect that followed opened
 * with an unterminated quote. A separator inside quotes is data, like every other character.
 */
test("a separator inside quotes does not end the command", async () => {
  const ddl = "$this->dbforge->drop_column('users','email');";
  assert.deepEqual(writeTargets(`echo "${ddl}" > app/migrations/001_drop.php`), ["app/migrations/001_drop.php"]);
  assert.deepEqual(writeTargets('echo "a && b" > out.txt'), ["out.txt"]);
  assert.deepEqual(writeTargets("echo one > a.txt; echo two > b.txt"), ["a.txt", "b.txt"], "a bare separator still splits");
});

/** The old scan required whitespace before the operator, so these two were never seen. */
test("a redirect with no space before it is still a redirect", async () => {
  assert.deepEqual(writeTargets("cat a>src/a.ts"), ["src/a.ts"]);
  assert.deepEqual(writeTargets("node x.mjs 2> src/err.log"), ["src/err.log"]);
  assert.deepEqual(writeTargets('echo hi > "out file.txt"'), ["out file.txt"], "a quoted path still resolves");
  assert.deepEqual(writeTargets("make test > t.log 2>&1"), ["t.log"], "a file descriptor dup names no file");
});


/**
 * Measured: an agent repaired a config kiln had corrupted with `node -e "... require('fs')
 * ... .kiln/config.json ..."`, and it was allowed. D48 is not "config.json is hard to edit"
 * — it is that the agent cannot change the terms it is judged by.
 *
 * #95 made this door wider by making it honest: a `>` inside quotes is data, so
 * `sh -c "echo x > path"` no longer trips the redirect scan by accident.
 *
 * The program is not read. What is read is whether it names a file the enforcement is made
 * of, because "kiln cannot see what this does" and "this may touch what judges the run"
 * cannot both hold.
 */
test("an inline program may not name the files that enforce the run", async () => {
  const project = kilnProject({ gates: { plan: "approved" } });
  const config = join(project.root, ".kiln", "config.json");

  assert.equal(await bash(`node -e "require('fs').writeFileSync('${config}','{}')"`, project), BLOCK);
  assert.equal(await bash(`python3 -c "open('.kiln/config.json','w')"`, project), BLOCK);
  assert.equal(await bash('sh -c "echo x > .git/hooks/pre-push"', project), BLOCK, "the door #95 opened, named");
  assert.equal(await bash(`node -e "console.log(require('./.kiln/work/w1/state.json'))"`, project), BLOCK);

  assert.equal(await bash('node -e "console.log(1+1)"', project), ALLOW, "an interpreter is not itself the offence");
  assert.equal(await bash("npm run build", project), ALLOW);
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

// ---------------------------------------------------------------- D67c, the SHIP commit

test("D67c: a broad git add is blocked while a run is active", async () => {
  const project = kilnProject({ gates: { plan: "approved" } });
  for (const command of ["git add -A", "git add --all", "git add ."]) {
    assert.equal(await bash(command, project), BLOCK, command);
  }
});

test("D67c: staging named paths is what the law asks for, and passes", async () => {
  const project = kilnProject({ gates: { plan: "approved" } });
  assert.equal(await bash("git add src/app.ts tests/app.test.ts", project), ALLOW);
});

test("D67c: kiln does not police a broad add in a session it is not driving", async () => {
  const project = kilnProject({ gates: {} });
  assert.equal(await bash("git add -A", project, "another-session"), ALLOW);
});

// ------------------------------------------- the first real run shipped with these off

test("a work opened without a session is claimed by the first guarded call", async () => {
  const project = kilnProject({ gates: {} });
  writeState(project.root, { ...readState(project.root, "42"), session_id: null });

  assert.equal(await edit(project.source, project, "a-real-session"), BLOCK, "the gate applies once someone owns it");
  assert.equal(readState(project.root, "42").session_id, "a-real-session", "and the owner is recorded");
});

test("an unowned work is what turned guard-gate off on the first real run", async () => {
  const project = kilnProject({ gates: {} });
  writeState(project.root, { ...readState(project.root, "42"), session_id: null });

  const { claimUnbound } = await import("../lib/guards/context.mjs");
  assert.equal(claimUnbound(project.root, null), null, "a payload with no session claims nothing");
});

test("two unowned works are a guess, and a guess about ownership is worse than none", async () => {
  const project = kilnProject({ gates: { plan: "approved" } });
  writeState(project.root, { ...readState(project.root, "42"), session_id: null });
  writeState(project.root, { ...newWork({ id: "99", sessionId: null, base: "bbb" }) });

  const { claimUnbound } = await import("../lib/guards/context.mjs");
  assert.equal(claimUnbound(project.root, "a-session"), null);
});

/**
 * Measured on a real run. The agent wrote `brief.md` into a work directory before running
 * `kiln open` — the order kiln's own skill documented. The directory then existed with no
 * `state.json`, every read of it threw, the dispatcher turned the throw into a block, and
 * EVERY Bash call in the session was refused, including the `kiln doctor` the error message
 * told the user to run. The only way out was deleting the directory from another terminal.
 */
test("a half-made work directory does not brick the session", async () => {
  const { root } = kilnProject({ gates: { plan: "approved" } });
  mkdirSync(join(root, ".kiln", "work", "half-made"), { recursive: true });

  assert.equal(await dispatch("pre-bash", payload({ command: "npm test", root })), 0, "no state to read is not a reason to stop everything");
  assert.equal(await dispatch("pre-edit", payload({ file: join(root, "src", "app.ts"), root })), 0);
});

test("a corrupt state still blocks, because that is the shape D33 is about", async () => {
  const { root } = kilnProject({ gates: { plan: "approved" } });
  mkdirSync(join(root, ".kiln", "work", "corrupt"), { recursive: true });
  writeFileSync(join(root, ".kiln", "work", "corrupt", "state.json"), "{ not json", "utf8");

  assert.equal(await dispatch("pre-bash", payload({ command: "npm test", root })), 2);
});

test("a work directory belongs to the work that owns it, and to nobody with none open", async () => {
  const { root, id } = kilnProject({ gates: { plan: "approved" } });
  const mine = join(root, ".kiln", "work", id, "brief.md");
  const theirs = join(root, ".kiln", "work", "someone-else", "brief.md");

  assert.equal(await dispatch("pre-edit", payload({ file: mine, root })), 0);
  assert.equal(await dispatch("pre-edit", payload({ file: theirs, root })), 2, "this is how a work with no state came to exist");
  assert.equal(
    await dispatch("pre-edit", payload({ file: theirs, root, session: "a-session-with-nothing-open" })),
    2,
    "having no work open is not permission to invent one",
  );
});

/**
 * D48 is not "config.json is hard to edit" but "the agent cannot change the terms it is
 * judged by". A project rule became such a term the moment a stage started reading one:
 * an agent that finds a rule inconvenient must not be able to answer it by rewriting the
 * rule, because `state.rules[]` would still claim the run was handed the old text.
 */
test("E22: a run may not write the project rules it is judged by", async () => {
  const project = kilnProject({ gates: { plan: "approved" } });
  const rule = join(project.root, ".kiln", "rules", "auth.md");

  assert.equal(await edit(rule, project), BLOCK, "Edit");
  assert.equal(await bash(`echo x > ${rule}`, project), BLOCK, "a redirect");
  assert.equal(await bash(`rm -f ${rule}`, project), BLOCK, "deleting a rule is a stronger edit than writing one");
  assert.equal(await bash(`mv /tmp/x ${rule}`, project), BLOCK, "moving one over it");
  assert.equal(await bash(`node -e "require('fs').unlinkSync('.kiln/rules/auth.md')"`, project), BLOCK, "the path the sandbox cannot see");

  assert.equal(await edit(project.source, project), ALLOW, "source is still the run's to write");
});

/**
 * Outside a run nothing is being judged, and a person asking their agent to help write a
 * rule is doing exactly what the router is for. Blocking that would make the feature
 * unusable to set up.
 */
test("a session kiln is not driving may write a rule", async () => {
  const project = kilnProject({ gates: { plan: "approved" } });
  const rule = join(project.root, ".kiln", "rules", "auth.md");
  assert.equal(await edit(rule, project, "some-other-session"), ALLOW);
});

/**
 * Refusing to follow a symlink is deliberate (D52; agent-skills #295 rates the
 * arbitrary-file-overwrite primitive High). How it was *reported* was not: the throw
 * reached the dispatcher's catch-all, and the agent was told "This is a bug in kiln, not in
 * your change. Run `kiln doctor`" — which is false, and doctor then prints `Ready.`
 *
 * Measured on a clone of zod, whose README.md is a symlink into packages/. Editing a README
 * is an ordinary thing to be asked for, and the agent was told the tool was broken.
 */
test("a symlink is refused as a decision, not reported as a bug in kiln", async () => {
  const project = kilnProject({ gates: { plan: "approved" } });
  const real = join(project.root, "src", "real.ts");
  writeFileSync(real, "export const a = 1;\n");
  const link = join(project.root, "src", "link.ts");
  symlinkSync(real, link);

  const message = blockMessage("pre-edit", payload({ file: link, root: project.root }));
  assert.match(message, /it is a symlink/);
  assert.match(message, new RegExp(real.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the file it points at is the remedy");
  assert.doesNotMatch(message, /bug in kiln/, "kiln did what it was designed to do");
  assert.doesNotMatch(message, /kiln doctor/, "doctor says Ready and knows nothing about this path");
});

test("a symlink pointing at nothing says so, rather than naming a file that is not there", async () => {
  const project = kilnProject({ gates: { plan: "approved" } });
  const link = join(project.root, "src", "dangling.ts");
  symlinkSync(join(project.root, "src", "gone.ts"), link);

  const message = blockMessage("pre-edit", payload({ file: link, root: project.root }));
  assert.match(message, /points at something that does not exist/);
});

/**
 * D19 listed three allowed writes: project source, `.kiln/work/<active-id>/`, and
 * `.kiln/tmp/<active-id>/`. The third was never implemented, so scratch space was judged as
 * source and needed the plan gate — which is exactly what an agent has not got yet while it
 * is investigating.
 *
 * Measured on a real run: every path an agent might put a temp file in was refused before
 * the plan gate. The harness's own scratchpad is outside the project, so the sandbox refuses
 * it; the repository refuses it for want of a gate; and `.kiln/tmp/` refused it for the same
 * reason. Nowhere to write, and no message naming anywhere.
 */
test("a temp file has somewhere to go before the plan gate", async () => {
  const project = kilnProject();
  assert.equal(await edit(join(project.root, ".kiln", "tmp", "42", "notes.txt"), project), ALLOW, "no gate is approved here");
  assert.equal(await bash(`echo x > ${join(project.root, ".kiln", "tmp", "42", "out.log")}`, project), ALLOW, "and through the shell");
  assert.equal(await edit(project.source, project), BLOCK, "source still needs its gate");
});

test("scratch belongs to one work, like its artifacts do", async () => {
  const project = kilnProject();
  assert.equal(await edit(join(project.root, ".kiln", "tmp", "99", "notes.txt"), project), BLOCK, "another run's step logs are its evidence");
  assert.equal(await edit(join(project.root, ".kiln", "tmp", "loose.txt"), project), BLOCK, "and the tree root belongs to nobody");
});

/**
 * kiln cannot verify that a path outside the project is the harness's scratchpad — it is
 * handed a command, not the harness's configuration, and matching `/tmp/claude-*` would be
 * the guessing this project refuses. So the boundary does not move; what changes is that the
 * refusal names a place that exists. A block naming nowhere to go is the shape that makes an
 * agent invent one.
 */
test("a write outside the project names the place a temp file does belong", async () => {
  const project = kilnProject();
  const message = blockMessage("pre-edit", payload({ file: "/tmp/somewhere-else/notes.txt", root: project.root }));
  assert.match(message, /outside the project root/);
  assert.match(message, /\.kiln\/tmp\/42\//, "the remedy is a path, not a principle");
  assert.match(message, /gitignored/);
});
