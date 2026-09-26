/**
 * D203: a work can end without shipping. Before `kiln close`, a spike or an abandoned work
 * stayed open for good — gating the session's edits and claiming its files.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { STATUS, runChecks } from "../lib/doctor.mjs";
import { resumeAction } from "../lib/resolve.mjs";
import { cleanupFixtures, writeFile } from "./helpers/fixture.mjs";
import { SESSION, kiln, nodeProject, ok, state } from "./helpers/journey.mjs";
import { judge } from "./helpers/hook.mjs";

after(cleanupFixtures);

const DENY = 2;
const ALLOW = 0;
const edit = (root, file) => judge("pre-edit", { session_id: SESSION, cwd: root, tool_input: { file_path: join(root, file) } });

test("D203: closing takes the user's words, and without them nothing changes", () => {
  const root = nodeProject({ name: "close-words" });
  ok(root, ["open", "w1", "--session", SESSION, "--path", "spike"]);
  const bare = kiln(root, ["close", "w1"]);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /the user's call/);
  assert.equal(state(root, "w1").status, "in_progress");
});

test("D203: a closed work gates nothing, claims nothing, and leaves no temp files", async () => {
  const root = nodeProject({ name: "close-gate" });
  ok(root, ["open", "w1", "--session", SESSION, "--path", "spike"]);
  writeFile(join(root, ".kiln", "tmp", "w1", "scratch.txt"), "x");
  assert.equal((await edit(root, "src/app.js")).status, DENY, "a spike never authorises source");

  ok(root, ["close", "w1", "--answer", "the spike answered it; nothing to build"]);
  const closed = state(root, "w1");
  assert.equal(closed.status, "closed");
  assert.deepEqual(closed.carry_over.at(-1), { from_pass: closed.pass, kind: "close", text: "the spike answered it; nothing to build" });
  assert.equal(existsSync(join(root, ".kiln", "tmp", "w1")), false);
  assert.equal((await edit(root, "src/app.js")).status, ALLOW);
});

test("D203: a closed work is not reopened or closed twice; a follow-up names it", () => {
  const root = nodeProject({ name: "close-reopen" });
  ok(root, ["open", "w1", "--session", SESSION]);
  ok(root, ["close", "w1", "--answer", "abandoned"]);
  const reopen = kiln(root, ["open", "w1", "--session", SESSION]);
  assert.equal(reopen.status, 1);
  assert.match(reopen.stderr, /is closed, and a closed work is not reopened[\s\S]*--follows w1/);
  assert.match(kiln(root, ["close", "w1", "--answer", "again"]).stderr, /already closed/);
  assert.equal(resumeAction(state(root, "w1")).action, "follow_up");
});

test("D203: doctor names an open work untouched for a week, and closes nothing", () => {
  const root = nodeProject({ name: "close-doctor" });
  ok(root, ["open", "w1", "--session", SESSION]);
  const stale = () => runChecks(root, loadConfig(root)).find((check) => check.title === "open work is current");
  assert.equal(stale().status, STATUS.ok);

  const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(join(root, ".kiln", "work", "w1", "state.json"), weekAgo, weekAgo);
  assert.equal(stale().status, STATUS.warn);
  assert.match(stale().detail, /w1 \(8 days\)[\s\S]*kiln close <id>/);
  assert.equal(state(root, "w1").status, "in_progress");
});
