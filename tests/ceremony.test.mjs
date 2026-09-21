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
  const verdict = autoEligible("spike", { auto: { bounded: true, full: true } });
  assert.equal(verdict.eligible, false);
  assert.match(verdict.reason, /a question/);
});

test("D16: bounded is eligible only when it is switched on, and default is off", () => {
  assert.equal(autoEligible("bounded", { auto: { bounded: true } }).eligible, true);
  assert.equal(autoEligible("bounded", { auto: { bounded: false } }).eligible, false);
  assert.equal(autoEligible("bounded", {}).eligible, false, "default off");
});

test("D16: full needs its own opt-in, which bounded's does not grant", () => {
  assert.equal(autoEligible("full", { auto: { bounded: true } }).eligible, false);
  assert.equal(autoEligible("full", { auto: { bounded: true, full: true } }).eligible, true);
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
