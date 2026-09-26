/**
 * D208: a snapshot at the gate that opens source and after each passing task, and
 * `kiln restore` back to one — through git's own checkout, so filters, modes and links survive.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { cleanupFixtures, commitAll, git, tempRoot, writeFile } from "./helpers/fixture.mjs";
import { kiln, monorepo, nodeProject, ok, state, throughPlanGate, writeReview } from "./helpers/journey.mjs";
import { writeConfig } from "./helpers/fixture.mjs";
import { DEFAULTS } from "../lib/config.mjs";

after(cleanupFixtures);

const refs = (root) => git(root, ["for-each-ref", "--format=%(refname)", "refs/kiln/snapshot/"]).trim().split("\n").filter(Boolean);

function started(name, options) {
  const root = nodeProject({ name, ...options });
  git(root, ["checkout", "-q", "-b", "feature/x"]);
  throughPlanGate(root, "w1");
  return root;
}

test("D208: the gate that opens source takes task/0, a passing task takes its own, a failing one none", () => {
  const root = started("snap-take");
  assert.deepEqual(state(root, "w1").snapshots.map((entry) => entry.name), ["task/0"]);
  writeFile(join(root, "src", "app.js"), "export const a = 2;\n");
  assert.match(ok(root, ["verify", "w1", "--task", "1/2"]).stdout, /Snapshot task\/1 taken/);
  const [first, second] = state(root, "w1").snapshots.map((entry) => entry.commits["."]);
  assert.equal(git(root, ["rev-parse", `${second}^`]).trim(), first, "each snapshot follows the last");
  assert.doesNotMatch(git(root, ["ls-tree", "-r", "--name-only", second]), /^\.kiln\//m, "a gate record is never in a snapshot");
  assert.equal(refs(root).length, 2);

  writeConfig(root, { ...DEFAULTS, stack: { id: "node", cmd: { test: "exit 1" }, steps: [{ id: "unit", run: "${cmd.test}" }] } });
  kiln(root, ["verify", "w1", "--task", "2/2"]);
  assert.equal(state(root, "w1").snapshots.length, 2, "a failed run is not a save point");
});

test("D208: restore writes back modified, deleted and added files as git would — line endings, links, modes — and can be undone", () => {
  const root = nodeProject({ name: "snap-restore" });
  git(root, ["checkout", "-q", "-b", "feature/x"]);
  writeFile(join(root, ".gitattributes"), "*.txt eol=crlf\n");
  writeFile(join(root, "src", "notes.txt"), "one\ntwo\n");
  writeFile(join(root, "src", "run.sh"), "#!/bin/sh\n");
  chmodSync(join(root, "src", "run.sh"), 0o755);
  symlinkSync("app.js", join(root, "src", "link.js"));
  commitAll(root, "fixtures");
  throughPlanGate(root, "w1");

  writeFile(join(root, "src", "app.js"), "broken\n");
  unlinkSync(join(root, "src", "notes.txt"));
  unlinkSync(join(root, "src", "link.js"));
  chmodSync(join(root, "src", "run.sh"), 0o644);
  writeFile(join(root, "src", "extra.js"), "new\n");
  const run = ok(root, ["restore", "w1", "--to", "task/0"]);

  assert.equal(readFileSync(join(root, "src", "app.js"), "utf8"), "export const a = 1;\n");
  assert.equal(readFileSync(join(root, "src", "notes.txt"), "utf8"), "one\r\ntwo\r\n", "smudged as a checkout would, not the stored LF");
  assert.equal(readlinkSync(join(root, "src", "link.js")), "app.js");
  assert.ok(statSync(join(root, "src", "run.sh")).mode & 0o100, "the exec bit comes back");
  assert.equal(existsSync(join(root, "src", "extra.js")), false);
  assert.match(run.stdout, /Undo with `kiln restore w1 --to undo\/1`/);

  ok(root, ["restore", "w1", "--to", "undo/1"]);
  assert.equal(readFileSync(join(root, "src", "app.js"), "utf8"), "broken\n");
  assert.ok(lstatSync(join(root, "src", "extra.js")).isFile());
});

test("D208: restore leaves the user's earlier changes and another work's claims alone", () => {
  const root = nodeProject({ name: "snap-scope" });
  git(root, ["checkout", "-q", "-b", "feature/x"]);
  writeFile(join(root, "src", "mine.js"), "the user's\n");
  writeFile(join(root, "src", "other.js"), "x\n");
  commitAll(root, "files");
  writeFile(join(root, "src", "mine.js"), "the user's, edited before the work\n");
  throughPlanGate(root, "w1");
  ok(root, ["open", "w2", "--session", "other-session"]);
  writeFile(join(root, ".kiln", "work", "w2", "plan.md"), "# plan\n\n## Risk flags\n- none\n");
  ok(root, ["gate", "w2", "plan", "--answer", "Approve this plan as written", "--predicted", "src/other.js"]);

  writeFile(join(root, "src", "mine.js"), "the user's, edited again\n");
  writeFile(join(root, "src", "other.js"), "w2's edit\n");
  writeFile(join(root, "src", "app.js"), "w1's edit\n");
  const run = ok(root, ["restore", "w1", "--to", "task/0"]);
  assert.equal(readFileSync(join(root, "src", "app.js"), "utf8"), "export const a = 1;\n");
  assert.equal(readFileSync(join(root, "src", "mine.js"), "utf8"), "the user's, edited again\n");
  assert.equal(readFileSync(join(root, "src", "other.js"), "utf8"), "w2's edit\n");
  assert.match(run.stdout, /left as it is: src\/other\.js/);
});

test("D208: no restore after the review gate or while halted, and ship and close drop the refs", () => {
  const root = started("snap-refuse");
  writeReview(root, "w1");
  ok(root, ["gate", "w1", "review", "--answer", "1. Approve this as written (recommended)"]);
  const refused = kiln(root, ["restore", "w1", "--to", "task/0"]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /would ship unreviewed/);
  ok(root, ["ship", "w1", "--opened", "https://example.invalid/pr/1"]);
  assert.deepEqual(refs(root), []);

  const other = started("snap-halt");
  ok(other, ["halt", "w1", "--reason", "waiting"]);
  assert.match(kiln(other, ["restore", "w1", "--to", "task/0"]).stderr, /halted/);
  ok(other, ["close", "w1", "--answer", "abandoned"]);
  assert.deepEqual(refs(other), []);
});

test("D208: a submodule's files come back from its own snapshot, and its commit is left alone", () => {
  const root = monorepo();
  writeConfig(root, { ...DEFAULTS, stack: { id: "node", cmd: { test: "true" }, steps: [{ id: "unit", run: "${cmd.test}" }] } });
  git(root, ["checkout", "-q", "-b", "feature/x"]);
  throughPlanGate(root, "w1", { predicted: "AdminPage/src/User.php" });
  writeFile(join(root, "AdminPage", "src", "User.php"), "<?php // broken\n");
  ok(root, ["restore", "w1", "--to", "task/0"]);
  assert.equal(readFileSync(join(root, "AdminPage", "src", "User.php"), "utf8"), "<?php\n");
  assert.ok(git(join(root, "AdminPage"), ["for-each-ref", "refs/kiln/snapshot/"]).includes("task/0"), "the ref lives in the submodule's own repository");
});

test("D208: a gc in another worktree keeps the snapshots", () => {
  const root = started("snap-gc");
  const [entry] = state(root, "w1").snapshots;
  const other = join(tempRoot("kiln-snap-wt-"), "wt");
  git(root, ["worktree", "add", "-q", "-b", "side", other]);
  git(other, ["gc", "-q", "--prune=now"]);
  assert.equal(git(root, ["cat-file", "-t", entry.commits["."]]).trim(), "commit");
});
