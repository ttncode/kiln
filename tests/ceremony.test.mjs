import { monorepo, writeReview } from "./helpers/journey.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  CEREMONY,
  CeremonyError,
  PATHS,
  autoEligible,
  canRatchet,
  ceremonyFor,
  gateKeysFor,
  nextMove,
  taskPosition,
  ratchetRefusal,
  renderAutoRuled,
} from "../lib/ceremony.mjs";
import { AUTHORIZING, SHIP_AUTHORIZING, newWork } from "../lib/state.mjs";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "../lib/config.mjs";
import { readState, writeState } from "../lib/state.mjs";
import { cleanupFixtures, commitAll, initRepo, tempRoot, writeConfig, writeFile } from "./helpers/fixture.mjs";
import { judge } from "./helpers/hook.mjs";

after(cleanupFixtures);

test("D12: three paths, and ceremony is what differs between them", () => {
  assert.deepEqual(PATHS, ["spike", "bounded", "full"]);
  assert.deepEqual(CEREMONY.spike.gates, ["probe"]);
  assert.deepEqual(CEREMONY.bounded.gates, ["plan", "review"]);
  assert.deepEqual(CEREMONY.full.gates, ["spec", "plan", "review", "ship"]);
});

test("D28: classification is not a stage, so no path lists one", () => {
  for (const path of PATHS) {
    assert.equal(ceremonyFor(path).stages.includes("CLASSIFY"), false, `${path} lists a stage nobody can act on`);
  }
});

test("D23: there is no SCOPE stage either", () => {
  for (const path of PATHS) {
    assert.equal(ceremonyFor(path).stages.includes("SCOPE"), false);
  }
});

test("§3e: the full path runs seven stages, and spike runs two", () => {
  assert.equal(CEREMONY.full.stages.length, 7);
  assert.equal(CEREMONY.spike.stages.length, 2);
  assert.deepEqual(CEREMONY.spike.stages, ["INVESTIGATE", "IMPLEMENT"]);
});

test("D77: only the two shipping paths say they ship", () => {
  assert.equal(CEREMONY.spike.ships, false);
  assert.equal(CEREMONY.bounded.ships, true);
  assert.equal(CEREMONY.full.ships, true);
});

test("the gate tables cannot drift apart, because one function reads both", () => {
  for (const path of PATHS) {
    const keys = gateKeysFor(path);
    assert.equal(keys.source, AUTHORIZING[path]);
    assert.equal(keys.ship, SHIP_AUTHORIZING[path]);
  }
  assert.equal(gateKeysFor("spike").ship, null, "no gate authorizes shipping a spike");
});

test("an unknown path is refused with the three that exist", () => {
  assert.throws(() => ceremonyFor("architectural"), (err) => {
    assert.ok(err instanceof CeremonyError);
    assert.match(err.message, /spike, bounded, full/);
    return true;
  });
});

test("D12: the ratchet goes up and never down", () => {
  assert.equal(canRatchet("spike", { to: "bounded" }), true);
  assert.equal(canRatchet("spike", { to: "full" }), true);
  assert.equal(canRatchet("bounded", { to: "full" }), true);

  assert.equal(canRatchet("full", { to: "bounded" }), false);
  assert.equal(canRatchet("bounded", { to: "spike" }), false);
  assert.equal(canRatchet("bounded", { to: "bounded" }), false, "the same rung is not a move, recorded or not");
  assert.equal(canRatchet("bounded", { to: "bounded", untouched: true }), false);

  assert.equal(canRatchet("full", { to: "spike", untouched: true }), true, "nothing recorded, nothing to launder");
});

test("a refused ratchet says which direction it refused", () => {
  assert.match(ratchetRefusal("full", "spike"), /only goes up/);
  assert.match(ratchetRefusal("bounded", "bounded"), /already on bounded/);
});

// ------------------------------------------------------------------ auto mode

test("D16: a spike is never eligible for auto mode", () => {
  const verdict = autoEligible("spike", { config: { auto: { bounded: true, full: true } } });
  assert.equal(verdict.eligible, false);
  assert.match(verdict.reason, /a question/);
});

test("D16: bounded is eligible only when it is switched on, and default is off", () => {
  assert.equal(autoEligible("bounded", { config: { auto: { bounded: true } } }).eligible, true);
  assert.equal(autoEligible("bounded", { config: { auto: { bounded: false } } }).eligible, false);
  assert.equal(autoEligible("bounded", {}).eligible, false, "default off");
});

test("D16: full needs its own opt-in, which bounded's does not grant", () => {
  assert.equal(autoEligible("full", { config: { auto: { bounded: true } } }).eligible, false);
  assert.equal(autoEligible("full", { config: { auto: { bounded: true, full: true } } }).eligible, true);
});

test("B58: a run that ruled on the user's behalf must print what it decided", () => {
  const state = {
    ...newWork({ id: "42", base: "aaa" }),
    gates: {
      plan: { decision: "approved", answer: "no open questions after investigate", by: "auto" },
      review: { decision: "accepted", answer: "2 findings, both Minor, fixed in round 1", by: "auto" },
    },
  };

  const block = renderAutoRuled(state);
  assert.match(block, /Auto-ruled 2 gates:/);
  assert.match(block, /plan → approved/);
  assert.match(block, /review → accepted/);
  assert.match(block, /Halts: none/);
  assert.match(block, /Your gate is now the PR\./);
});

test("B58: a gate the user gave is not reported as auto-ruled", () => {
  const state = {
    ...newWork({ id: "42", base: "aaa" }),
    gates: { plan: { decision: "approved", answer: "yes", by: "user" } },
  };
  assert.equal(renderAutoRuled(state), null, "nothing was decided on their behalf");
});

test("D16: a halt reaches the block, because auto mode never removes one", () => {
  const state = {
    ...newWork({ id: "42", base: "aaa" }),
    gates: { plan: { decision: "approved", answer: "clear", by: "auto" } },
    carry_over: [{ from_pass: 1, kind: "halt", text: "DROP COLUMN in the plan" }],
  };
  assert.match(renderAutoRuled(state), /Halts: DROP COLUMN in the plan/);
});

// ------------------------------------------------------------------ the ratchet, end to end

function spikeProject() {
  const root = initRepo(tempRoot("kiln-ratchet-"));
  writeFile(join(root, "package.json"), '{"name":"d","scripts":{"test":"echo ok"}}');
  commitAll(root, "init");
  writeConfig(root, DEFAULTS);
  writeState(root, newWork({ id: "42", sessionId: "s", base: "aaa", path: "spike" }));
  return root;
}

function kiln(root, args) {
  const bin = new URL("../bin/kiln.mjs", import.meta.url).pathname;
  return spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8" });
}

test("D78: the ratchet reports untracked work, because a spike's output is usually new files", () => {
  const root = spikeProject();
  writeFile(join(root, "spike-scratch.js"), "// probe\n");

  const run = kiln(root, ["ratchet", "42", "bounded"]);

  assert.equal(run.status, 0);
  assert.match(run.stdout, /spike-scratch\.js/, "git diff alone would have called this clean");
  assert.match(run.stdout, /1\. Keep it.*\n2\. Set it aside.*\n3\. Stop here/, "D78: a halt with a numbered menu, not a decision taken by carrying on");
  assert.equal(readState(root, "42").status, "halted");
  assert.doesNotMatch(run.stdout, /\.kiln\//, "kiln's own record is not the spike's work");
});

test("D194: files already dirty when the work opened are not the earlier path's work", () => {
  const root = spikeProject();
  writeFile(join(root, ".gitignore"), ".kiln/tmp/\n");
  writeState(root, newWork({ id: "42", sessionId: "s", base: "aaa", path: "spike", dirtyAtOpen: [".gitignore"] }));
  const free = kiln(root, ["ratchet", "42", "bounded"]);
  assert.match(free.stdout, /Nothing was recorded or changed yet/, "the file kiln init left untracked is not something the spike did");

  writeState(root, { ...newWork({ id: "43", sessionId: "s", base: "aaa", path: "spike", dirtyAtOpen: [".gitignore"] }), gates: { probe: { decision: "approved" } } });
  writeFile(join(root, "spike-scratch.js"), "// probe\n");
  const menu = kiln(root, ["ratchet", "43", "bounded"]).stdout;
  assert.match(menu, /spike-scratch\.js/);
  const listing = menu.split("\n1. Keep")[0];
  assert.doesNotMatch(listing, /\.gitignore/, "a file dirty before the work opened is not offered as the spike's to keep or set aside");
  assert.match(menu, /':\(exclude\)\.gitignore'/, "and the stash the menu prints leaves it where it is");
});

test("D204: the stash the ratchet menu prints is one the removal guard lets through", async () => {
  const root = spikeProject();
  writeState(root, { ...newWork({ id: "43", sessionId: "s", base: "aaa", path: "spike" }), gates: { probe: { decision: "approved" } } });
  writeFile(join(root, "spike-scratch.js"), "// probe\n");
  const menu = kiln(root, ["ratchet", "43", "bounded"]).stdout;
  const printed = /2\. Set it aside yourself first, then continue: `([^`]+)`/.exec(menu)?.[1];
  assert.ok(printed, menu);
  const verdict = (command) => judge("pre-bash", { session_id: "s", cwd: root, tool_input: { command } });
  assert.equal((await verdict(printed)).status, 0, printed);
  assert.equal((await verdict("git stash -u")).status, 2, "the bare spelling takes .kiln/ with it");
});

test("D78: the ratchet leaves the working tree exactly as it found it", () => {
  const root = spikeProject();
  const scratch = writeFile(join(root, "spike-scratch.js"), "// probe\n");
  const before = readFileSync(scratch, "utf8");

  kiln(root, ["ratchet", "42", "bounded"]);

  assert.equal(readFileSync(scratch, "utf8"), before, "deleting it would be D7 item 2, done by kiln");
  assert.equal(readState(root, "42").path, "bounded");
});

test("D78: the ratchet clears the old path's gates and records itself", () => {
  const root = spikeProject();
  writeState(root, { ...readState(root, "42"), gates: { probe: { decision: "approved", by: "user", answer: "yes" } } });

  kiln(root, ["ratchet", "42", "bounded"]);

  const state = readState(root, "42");
  assert.deepEqual(state.gates, {}, "a probe approval does not authorize a bounded run");
  assert.deepEqual(state.carry_over.map((row) => row.kind), ["ratchet"]);
});

/**
 * The ban on going down stops a task that proved large becoming cheap again, and stops
 * pre-plan code being laundered past a gate written for a different artifact. Both need
 * something to launder — so it starts applying once there is one.
 */
test("D12: a downward ratchet is refused once a gate is recorded", () => {
  const root = spikeProject();
  kiln(root, ["ratchet", "42", "full"]);
  writeFile(join(root, ".kiln", "work", "42", "spec.md"), "# spec\n");
  const recorded = kiln(root, ["gate", "42", "spec", "--artifact", ".kiln/work/42/spec.md", "--answer", "approve"]);
  assert.match(recorded.stdout, /"recorded": true/, recorded.stderr);

  const run = kiln(root, ["ratchet", "42", "bounded"]);
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /only goes up/);
});

test("before a gate exists, the path moves in either direction", () => {
  const root = spikeProject();
  assert.equal(kiln(root, ["ratchet", "42", "full"]).status, 0);

  const down = kiln(root, ["ratchet", "42", "spike"]);
  assert.equal(down.status, 0, `${down.stdout}${down.stderr}`);
  assert.equal(readState(root, "42").path, "spike", "classification happens after open, so it has to be correctable");
});

test("open refuses a ceremony path that does not exist", () => {
  const root = initRepo(tempRoot("kiln-open-path-"));
  writeConfig(root, DEFAULTS);
  writeFile(join(root, "a.txt"), "a");
  commitAll(root, "first");
  const bin = new URL("../bin/kiln.mjs", import.meta.url).pathname;
  const run = spawnSync(process.execPath, [bin, "open", "w1", "--path", "heavy"], { cwd: root, encoding: "utf8" });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /no ceremony path named "heavy"/);
});

/**
 * `--auto` meant "record approved, no questions asked", and `autoEligible` — the rule
 * saying when that is allowed — had no caller outside this file. A flag that approves on
 * request is not auto mode; it is a way past the gate. These go through the real CLI,
 * because calling the predicate was exactly what kept the hole open.
 */
function autoProject(auto) {
  const root = initRepo(tempRoot("kiln-auto-"));
  writeFile(join(root, "package.json"), '{"name":"d","scripts":{"test":"echo ok"}}');
  commitAll(root, "init");
  writeConfig(root, { ...DEFAULTS, auto });
  writeFile(join(root, ".kiln", "rules", "index.md"), "# rules\n");
  writeFile(join(root, ".kiln", "work", "42", "plan.md"), "# plan\n\n## Risk flags\n- none\n");
  writeState(root, newWork({ id: "42", sessionId: "s", base: "aaa", path: "bounded" }));
  return root;
}

const autoGate = (root, id = "42") => kiln(root, ["gate", id, "plan", "--artifact", `.kiln/work/${id}/plan.md`, "--auto"]);

test("B58: with auto on, the gate is ruled and the report says so", () => {
  const root = autoProject({ bounded: true });
  assert.equal(autoGate(root).status, 0);

  assert.equal(readState(root, "42").gates.plan.by, "auto");
  const report = kiln(root, ["report", "42"]);
  assert.match(report.stdout, /Auto-ruled 1 gate/);
  assert.match(report.stdout, /plan → approved/);
});

test("B58: with auto off — the default — the same call is refused", () => {
  const run = autoGate(autoProject({}));
  assert.equal(run.status, 2);
  assert.match(run.stderr, /auto is off/);
  assert.match(run.stderr, /Ask the user/);
});

test("B60/B61: a spike is never eligible and full needs its own opt-in", () => {
  const spike = autoProject({ bounded: true, full: true });
  writeState(spike, { ...readState(spike, "42"), path: "spike" });
  assert.match(autoGate(spike).stderr, /not a change/);

  const full = autoProject({ bounded: true });
  writeState(full, { ...readState(full, "42"), path: "full" });
  assert.match(autoGate(full).stderr, /explicit opt-in/);
});

test("B59: auto does not rule past a halt", () => {
  const root = autoProject({ bounded: true });
  kiln(root, ["halt", "42", "--reason", "DROP COLUMN in the plan"]);

  const run = autoGate(root);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /halted/);
});

test("open says whether a gate will be ruled for you, at the moment the path is chosen", () => {
  const off = autoProject({});
  assert.match(kiln(off, ["open", "w2"]).stdout, /auto mode is off for bounded/);

  const on = autoProject({ bounded: true });
  assert.match(kiln(on, ["open", "w2", "--path", "bounded"]).stdout, /auto mode is ON for bounded/);
});

/**
 * The user typed `/kiln --auto Remove this filter …` unprompted. kiln minted
 * `20260921-auto-remove-filter-…` and turned nothing on: the instruction became a word in
 * the id. The flag is also the only lever an agent can honour — the harness refuses an
 * agent editing the config that governs its own gates, by name, as [Self-Modification].
 */
test("--auto in the request rules this run's gates, and config is not touched", () => {
  const root = autoProject({});
  assert.match(kiln(root, ["open", "w2", "--path", "bounded", "--auto"]).stdout, /auto mode is ON for bounded \(the --auto in your request\)/);
  assert.equal(readState(root, "w2").auto, true);

  writeFile(join(root, ".kiln", "work", "w2", "plan.md"), "# plan\n\n## Risk flags\n- none\n");
  const ruled = kiln(root, ["gate", "w2", "plan", "--artifact", ".kiln/work/w2/plan.md", "--auto"]);
  assert.equal(ruled.status, 0, ruled.stderr);
  assert.equal(readState(root, "w2").gates.plan.by, "auto");

  const config = JSON.parse(readFileSync(join(root, ".kiln", "config.json"), "utf8"));
  assert.equal(config.auto.bounded, undefined, "a run's flag never writes the standing default");
});

test("--auto satisfies full's opt-in, and never reaches a spike", () => {
  const root = autoProject({});
  kiln(root, ["open", "wf", "--path", "full", "--auto"]);
  writeFile(join(root, ".kiln", "work", "wf", "spec.md"), "# spec\n");
  assert.equal(kiln(root, ["gate", "wf", "spec", "--artifact", ".kiln/work/wf/spec.md", "--auto"]).status, 0);

  kiln(root, ["open", "ws", "--path", "spike", "--auto"]);
  writeFile(join(root, ".kiln", "work", "ws", "brief.md"), "# brief\n");
  const spike = kiln(root, ["gate", "ws", "probe", "--artifact", ".kiln/work/ws/brief.md", "--auto"]);
  assert.equal(spike.status, 2);
  assert.match(spike.stderr, /not a change/);
});

/**
 * Two works shared one session on a real run, and `workForSession` returns whichever the
 * filesystem lists first — so which work's gates authorise an edit became arbitrary.
 * `claimUnbound` already refuses to guess when two works are unowned; this is the same law
 * from the other side, refused at open rather than at the first edit.
 */
test("a session drives one unit of work", () => {
  const root = autoProject({});
  assert.equal(kiln(root, ["open", "w1", "--session", "s9"]).status, 0);

  const second = kiln(root, ["open", "w2", "--session", "s9"]);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /already drives work w1/);
  assert.match(second.stderr, /kiln halt w1/, "the way out is named, not left to guess");

  kiln(root, ["halt", "w1", "--reason", "parked"]);
  const after = kiln(root, ["open", "w2", "--session", "s9"]);
  assert.equal(after.status, 0, `the refusal names halt as the way out, so halt has to be one: ${after.stderr}`);
});

test("claiming an unowned work is not taking one from anybody", () => {
  const root = autoProject({});
  kiln(root, ["open", "w3"]);

  const claimed = kiln(root, ["open", "w3", "--session", "s1"]);
  assert.match(claimed.stdout, /claimed work w3, which had no session/);
  assert.doesNotMatch(claimed.stdout, /will be blocked/, "there was no previous session to warn about");

  const taken = kiln(root, ["open", "w3", "--session", "s2"]);
  assert.match(taken.stdout, /took over work w3 from session s1/);
  assert.match(taken.stdout, /next source edit will be blocked/);
});

/**
 * Three works shipped or reached VERIFY with `verify: []`, and `kiln report` said nothing
 * about it — the only account of "no test ran on this change" was whatever the agent chose
 * to mention. Shipping unverified is the user's call; finding out afterwards is not.
 */
test("the report says whether anything was verified", () => {
  const root = autoProject({});
  kiln(root, ["open", "wv"]);
  assert.match(kiln(root, ["report", "wv"]).stdout, /Verified: never/);

  const skipped = { ...readState(root, "wv"), verify: [{ id: "unit", skipped: "requires migrate" }] };
  writeState(root, skipped);
  assert.match(kiln(root, ["report", "wv"]).stdout, /Verified: never/, "a skipped step is not a step that ran");

  writeState(root, { ...skipped, verify: [{ id: "unit", exit: 0 }], last_verified: "deadbeef123" });
  assert.match(kiln(root, ["report", "wv"]).stdout, /was green at deadbeef1, and the tree has changed since/, "a record that names no tree is not evidence for this one");
});

/**
 * `open` on a work that exists, with no `--session`, adopted `undefined`: the owner was
 * wiped, pushed into `displaced`, and its very next source edit refused. `claimUnbound`
 * then re-claimed the now-unowned work, so the work listed its own owner as displaced —
 * twice over on a real run, because the skill re-opens a work to change its path.
 */
test("open without a session leaves the owner alone", () => {
  const root = autoProject({});
  kiln(root, ["open", "w1", "--session", "sess-A"]);

  const again = kiln(root, ["open", "w1"]);
  assert.match(again.stdout, /already exists and is driven by session sess-A. Nothing changed/);

  const state = readState(root, "w1");
  assert.equal(state.session_id, "sess-A", "the owner is untouched");
  assert.deepEqual(state.displaced, [], "and nobody was displaced");
});

test("a work never lists its own owner as displaced", () => {
  const root = autoProject({});
  kiln(root, ["open", "w1", "--session", "sess-A"]);
  kiln(root, ["open", "w1", "--session", "sess-B"]);
  assert.deepEqual(readState(root, "w1").displaced, ["sess-A"], "a real takeover still displaces");

  kiln(root, ["open", "w1", "--session", "sess-A"]);
  const state = readState(root, "w1");
  assert.equal(state.session_id, "sess-A");
  assert.deepEqual(state.displaced, ["sess-B"], "taking it back removes you from the list");
});

/**
 * `kiln halt` said "Source edits are blocked until this is resumed" and nothing could
 * resume it: `resolve` presents a halt, it does not clear one, and only a ship opened the
 * next pass. A work whose blocking unknown the user had answered stayed blocked for good —
 * the third message this session to name a remedy that did not exist.
 */
test("a halt ends when the question is answered", () => {
  const root = autoProject({});
  kiln(root, ["open", "w1", "--session", "s1"]);
  const halted = kiln(root, ["halt", "w1", "--reason", "outside readers still need the legacy table"]);
  assert.match(halted.stdout, /kiln resume w1 --answer/, "the remedy names itself");

  const resumed = kiln(root, ["resume", "w1", "--answer", "Those readers are in scope."]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(readState(root, "w1").status, "in_progress");

  const carried = readState(root, "w1").carry_over;
  assert.deepEqual(carried.map((row) => row.kind), ["halt", "resume"], "the answer sits beside the question");
  assert.equal(carried.at(-1).text, "Those readers are in scope.");
});

test("resume refuses what it cannot answer", () => {
  const root = autoProject({});
  kiln(root, ["open", "w1", "--session", "s1"]);

  const running = kiln(root, ["resume", "w1", "--answer", "x"]);
  assert.equal(running.status, 1);
  assert.match(running.stderr, /is in_progress, not halted/);

  kiln(root, ["halt", "w1", "--reason", "a question"]);
  const silent = kiln(root, ["resume", "w1"]);
  assert.equal(silent.status, 1);
  assert.match(silent.stderr, /a halt is a question/, "the same argument --reason won");
});

/**
 * #87 filtered the claiming session out of `displaced`, and an early return skipped the
 * filter when the session already owned the work — which is the only session that would
 * ever try to repair such a record. Found by applying the fix to the real one it was
 * written for, where it changed nothing.
 */
test("a work that already lists its owner as displaced is repaired by re-opening it", () => {
  const root = autoProject({});
  kiln(root, ["open", "w1", "--session", "sess-A"]);
  writeState(root, { ...readState(root, "w1"), displaced: ["sess-B", "sess-A"] });

  const again = kiln(root, ["open", "w1", "--session", "sess-A"]);
  assert.match(again.stdout, /is already yours. Nothing changed/, "it is not a claim, and not a takeover");
  assert.deepEqual(readState(root, "w1").displaced, ["sess-B"], "the owner stops being listed as displaced");
  assert.equal(readState(root, "w1").session_id, "sess-A");
});

/**
 * Measured on a five-hour run: the agent stopped twice between tasks while the skill said
 * "Execute all tasks from the plan without stopping", and when asked why, answered "the
 * skill says run continuously and I've been pausing anyway". Both stops came right after a
 * summary table, on a sentence promising to continue.
 *
 * Superpowers carries the same rule on a subagent per task; BMAD writes story status from
 * the build rather than from the agent, and its #387 and #496 show what prose alone does.
 * So the line rides on the call the contract already makes mandatory after every task.
 */
test("the position is read from the caller and the next move is printed, not narrated", () => {
  assert.deepEqual(taskPosition("3/8"), { task: 3, of: 8 });
  assert.deepEqual(taskPosition(" 3 / 8 "), { task: 3, of: 8 });
  assert.equal(taskPosition("9/8"), null, "a task beyond the total is not a position");
  assert.equal(taskPosition("0/8"), null);
  assert.equal(taskPosition("three of eight"), null);
  assert.equal(taskPosition(undefined), null, "the flag is optional");

  assert.match(nextMove({ task: 3, of: 8 }), /Task 4 is next — do not stop, and do not summarise\./);
  assert.match(nextMove({ task: 8, of: 8 }), /Every task is done; next is the review gate\./);
  assert.equal(nextMove(null), null);
});

/**
 * The two B58 tests above prove the block renders. Neither proved anyone ever sees it, and
 * that is exactly the gap that survived to production: `renderAutoRuled` was reachable only
 * through `kiln report`, a command nothing requires. Measured on the owner's first auto run —
 * two gates ruled `by: "auto"`, and the closing summary mentioned it in half a sentence.
 *
 * D16's reason for the block is that *without it auto mode is a black box, and a black box is
 * not trusted twice*. A renderer nobody calls is the same black box with a test beside it.
 */
function autoRun() {
  const root = autoProject({ bounded: true });
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  writeState(root, { ...readState(root, "42"), base: head });
  writeReview(root, "42");
  return root;
}

const ruleGate = (root, key) =>
  kiln(root, ["gate", "42", key, "--artifact", `.kiln/work/42/${key}.md`, "--auto"]);

test("B58: every auto ruling says so as it happens, and the last gate prints the whole block", () => {
  const root = autoRun();

  const plan = ruleGate(root, "plan");
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stderr, /ruled the plan gate on your behalf/);
  assert.doesNotMatch(plan.stderr, /Auto-ruled/, "the summary belongs at the end, not at every gate");

  const review = ruleGate(root, "review");
  assert.match(review.stderr, /ruled the review gate on your behalf/);
  assert.match(review.stderr, /Auto-ruled 2 gates:/, "review is the gate that authorises shipping on bounded");
  assert.match(review.stderr, /Your gate is now the PR\./);
});

test("B58: a gate the user gave prints nothing about auto mode", () => {
  const root = autoProject({ bounded: false });
  const run = kiln(root, ["gate", "42", "plan", "--artifact", ".kiln/work/42/plan.md", "--answer", "1. Approve this plan as written (recommended)"]);
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /on your behalf/);
});

test("D204: a superproject's stash does not recurse, so the menu names each changed submodule", () => {
  const root = monorepo();
  writeConfig(root, DEFAULTS);
  writeState(root, { ...newWork({ id: "43", sessionId: "s", base: "aaa", path: "spike" }), gates: { probe: { decision: "approved" } } });
  writeFile(join(root, "AdminPage", "src", "User.php"), "<?php // probe\n");
  const menu = kiln(root, ["ratchet", "43", "bounded"]).stdout;
  assert.match(menu, /then `git -C AdminPage stash push -u`/);
});
