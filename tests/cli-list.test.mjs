import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { DEFAULTS } from "../lib/config.mjs";
import { newWork, statePath, writeState } from "../lib/state.mjs";
import { cleanupFixtures, tempRoot, writeConfig } from "./helpers/fixture.mjs";

after(cleanupFixtures);

const bin = new URL("../bin/kiln.mjs", import.meta.url).pathname;

function project() {
  const root = tempRoot("kiln-list-");
  writeConfig(root, DEFAULTS);
  return root;
}

function list(root) {
  const run = spawnSync(process.execPath, [bin, "list"], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.split("\n").filter(Boolean);
}

test("list names its columns, so status is not read as stage", () => {
  const root = project();
  writeState(root, newWork({ id: "42", sessionId: "s", base: "aaa" }));

  const [header] = list(root);
  assert.match(header, /\bSTATUS\b/);
  assert.match(header, /\bSTAGE\b/);
});

test("columns line up when ids differ in length — the case tabs got wrong", () => {
  const root = project();
  writeState(root, newWork({ id: "42", sessionId: "s", base: "aaa" }));
  writeState(root, newWork({ id: "PROJ-1234", sessionId: "s", base: "bbb" }));

  const [header, short, long] = list(root);
  assert.equal(short.indexOf("in_progress"), long.indexOf("in_progress"));
  assert.equal(header.indexOf("STATUS"), short.indexOf("in_progress"));
  assert.equal(header.indexOf("STAGE"), short.indexOf("INVESTIGATE"));
});

test("an unreadable state still lists, with its non-numeric pass intact", () => {
  const root = project();
  writeState(root, newWork({ id: "42", sessionId: "s", base: "aaa" }));
  writeFileSync(statePath(root, "42"), "{ not json", "utf8");

  const [header, row] = list(root);
  assert.equal(header.indexOf("STATUS"), row.indexOf("unreadable"));
  assert.match(row, /-\s+-$/);
});

test("an empty project says so, with no header above nothing", () => {
  assert.deepEqual(list(project()), ["No work in progress."]);
});
