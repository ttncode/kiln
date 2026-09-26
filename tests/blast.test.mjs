import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  actualChanged,
  anchorVerdict,
  grepBlastRadius,
  reconcile,
  reconcileVerdict,
  reconciliationLine,
  statusPathOf,
} from "../lib/blast.mjs";
import { DEFAULTS } from "../lib/config.mjs";
import { newWork, readState, writeState } from "../lib/state.mjs";
import { cleanupFixtures, commitAll, git, initRepo, tempRoot, writeConfig, writeFile } from "./helpers/fixture.mjs";

after(cleanupFixtures);

function project(files = {}) {
  const root = initRepo(tempRoot("kiln-blast-"));
  writeFile(join(root, "package.json"), '{"name":"d"}');
  for (const [path, body] of Object.entries(files)) writeFile(join(root, path), body);
  const base = commitAll(root, "init");
  writeConfig(root, DEFAULTS);
  return { root, base };
}

function kiln(root, args) {
  const bin = new URL("../bin/kiln.mjs", import.meta.url).pathname;
  return spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8" });
}

// ------------------------------------------------------------------ tier 0 knowledge

test("D47: the null adapter is a real grep, never a no-op", () => {
  const { root } = project({
    "src/export.ts": "export function handleExport() {}\n",
    "src/routes.ts": "import { handleExport } from './export';\n",
    "README.md": "nothing relevant here\n",
  });

  const rows = grepBlastRadius(root, ["handleExport"]);
  assert.deepEqual(rows.map((r) => r.path).sort(), ["src/export.ts", "src/routes.ts"]);
});

test("more matched terms rank a file higher", () => {
  const { root } = project({
    "src/both.ts": "handleExport(); buildQuery();\n",
    "src/one.ts": "handleExport();\n",
  });

  const [first] = grepBlastRadius(root, ["handleExport", "buildQuery"]);
  assert.equal(first.path, "src/both.ts");
  assert.equal(first.hits, 2);
});

test("the walk skips what a blast radius must never include", () => {
  const { root } = project({
    "src/a.ts": "needle\n",
    "node_modules/pkg/index.js": "needle\n",
    ".kiln/work/42/brief.md": "needle\n",
  });

  assert.deepEqual(grepBlastRadius(root, ["needle"]).map((r) => r.path), ["src/a.ts"]);
});

/**
 * D197: measured on a real PHP project — a leftover `debug_helper.php -> debug_helper.php`,
 * untracked and gitignored, made `kiln blast` die with ELOOP before INVESTIGATE had searched
 * anything. ripgrep and `git grep` do not follow symbolic links by default, and a file that
 * cannot be read is skipped, not fatal.
 */
test("D197: a symbolic link is not followed, so a loop or a dangling link cannot stop the search", () => {
  const { root } = project({ "src/real.php": "needle\n" });
  symlinkSync("loop.php", join(root, "src", "loop.php"));
  symlinkSync("gone.php", join(root, "src", "dangling.php"));
  symlinkSync("real.php", join(root, "src", "alias.php"));
  assert.deepEqual(grepBlastRadius(root, ["needle"]).map((r) => r.path), ["src/real.php"], "the file is found at its real path, once");
});

test("no terms yields nothing rather than everything", () => {
  const { root } = project({ "src/a.ts": "x\n" });
  assert.deepEqual(grepBlastRadius(root, []), []);
  assert.deepEqual(grepBlastRadius(root, [""]), []);
});

test("a term with regex characters is matched literally", () => {
  const { root } = project({ "src/a.ts": "cost = a.b(c)\n", "src/b.ts": "axbxc\n" });
  assert.deepEqual(grepBlastRadius(root, ["a.b(c)"]).map((r) => r.path), ["src/a.ts"]);
});

// ------------------------------------------------------------------ actual changes

test("D31: actual covers committed, modified and untracked alike", () => {
  const { root, base } = project({ "src/a.ts": "one\n" });
  writeFile(join(root, "src", "a.ts"), "two\n");
  writeFile(join(root, "src", "new.ts"), "new\n");

  const actual = actualChanged(root, base);
  assert.ok(actual.includes("src/a.ts"), "modified but uncommitted");
  assert.ok(actual.includes("src/new.ts"), "untracked");
});

test("kiln's own directory is not part of the change under review", () => {
  const { root, base } = project({ "src/a.ts": "one\n" });
  writeFile(join(root, ".kiln", "work", "42", "brief.md"), "# brief\n");
  assert.deepEqual(actualChanged(root, base), []);
});

test("the status field is one or two characters wide, and a fixed slice is off by one", () => {
  assert.equal(statusPathOf("M src/a.ts"), "src/a.ts", "trimmed: one status character");
  assert.equal(statusPathOf(" M src/a.ts"), "src/a.ts", "untrimmed: a leading space");
  assert.equal(statusPathOf("?? src/new.ts"), "src/new.ts");
  assert.equal(statusPathOf("R  old.ts -> new.ts"), "new.ts", "a rename names its destination");
});

test("superpowers #2133: a moved integration branch does not read as deletions", () => {
  const { root } = project({ "src/a.ts": "one\n" });
  git(root, ["checkout", "-q", "-b", "feat/x"]);
  writeFile(join(root, "src", "mine.ts"), "mine\n");
  commitAll(root, "mine");

  git(root, ["checkout", "-q", "main"]);
  writeFile(join(root, "src", "theirs.ts"), "theirs\n");
  commitAll(root, "theirs");
  git(root, ["checkout", "-q", "feat/x"]);

  const actual = actualChanged(root, "main");
  assert.deepEqual(actual, ["src/mine.ts"], "three dots is merge-base, so theirs is not mine");
  assert.equal(actual.includes("src/theirs.ts"), false);
});

// ------------------------------------------------------------------ reconciliation

test("D23: reconciliation names what went beyond the plan and what the plan missed", () => {
  const result = reconcile({
    predicted: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
    actual: ["src/a.ts", "src/pool.ts", "src/session.ts"],
  });

  assert.equal(result.predicted, 2);
  assert.equal(result.actual, 3);
  assert.deepEqual(result.beyond, ["src/pool.ts", "src/session.ts"]);
  assert.deepEqual(result.notTouched, ["src/b.ts"]);
});

test("the line carries the numbers and stays one line", () => {
  const line = reconciliationLine(reconcile({
    predicted: [{ path: "a" }, { path: "b" }, { path: "c" }, { path: "d" }],
    actual: ["a", "b", "c", "e", "f", "g", "h", "i", "j", "k", "l"],
  }));

  assert.match(line, /predicted 4 · actual 11/);
  assert.match(line, /⚠ 8 beyond prediction/);
  assert.match(line, /1 predicted-not-touched/);
  assert.equal(line.includes("\n"), false, "statistics reach the conversation; the body stays a file");
});

test("D31: divergence reports and does not block", () => {
  const result = reconcile({ predicted: [{ path: "a" }], actual: ["a", "b", "c"] });
  assert.equal(reconcileVerdict(result).halt, false, "discovery during implementation is legitimate");
});

test("D56: a diff of zero files halts, and says the likely cause", () => {
  const verdict = reconcileVerdict(reconcile({ predicted: [{ path: "a" }], actual: [] }));
  assert.equal(verdict.halt, true);
  assert.match(verdict.reason, /another branch/);
});

test("D56: the halt reaches the exit code, not only the text", () => {
  const { root, base } = project({ "src/a.ts": "one\n" });
  writeState(root, { ...newWork({ id: "42", sessionId: "s", base }), last_verified: base, predicted: [{ path: "src/a.ts" }] });

  const run = kiln(root, ["scope", "42"]);
  assert.equal(run.status, 2, "review must not proceed over the absence of the thing under review");
  assert.match(run.stderr, /HALT/);
});

// ------------------------------------------------------------------ D72, claim time

test("D72: an overlapping claim is refused when the claim is registered", () => {
  const { root, base } = project({ "src/a.ts": "one\n" });
  writeState(root, { ...newWork({ id: "99", sessionId: "other", base }), predicted: [{ path: "src/a.ts" }] });
  writeState(root, newWork({ id: "42", sessionId: "mine", base }));
  writeFile(join(root, ".kiln", "work", "42", "plan.md"), "# plan\n\n## Risk flags\n- none\n");

  const run = kiln(root, ["gate", "42", "plan", "--answer", "yes", "--predicted", "src/a.ts"]);

  assert.equal(run.status, 2, "a conflict, not a deadlock two writes later");
  assert.match(run.stderr, /claimed by work 99/);
  assert.deepEqual(readState(root, "42").gates, {}, "nothing was recorded");
});

test("D72: disjoint claims are registered without complaint", () => {
  const { root, base } = project({ "src/a.ts": "one\n" });
  writeState(root, { ...newWork({ id: "99", sessionId: "other", base }), predicted: [{ path: "src/elsewhere.ts" }] });
  writeState(root, newWork({ id: "42", sessionId: "mine", base }));
  writeFile(join(root, ".kiln", "work", "42", "plan.md"), "# plan\n\n## Risk flags\n- none\n");

  const run = kiln(root, ["gate", "42", "plan", "--answer", "yes", "--predicted", "src/a.ts"]);

  assert.equal(run.status, 0);
  assert.deepEqual(readState(root, "42").predicted, [{ path: "src/a.ts" }]);
});

test("work already uncommitted when the run opened is not this run's doing", () => {
  const result = reconcile({
    predicted: [{ path: "src/a.ts" }],
    actual: ["src/a.ts", "notes.md"],
    dirtyAtOpen: ["notes.md"],
  });

  assert.equal(result.actual, 1, "the half-finished file the user left lying around");
  assert.deepEqual(result.beyond, [], "a line that cries wolf is a line people stop reading");
});

test("but a pre-existing file the plan claims is still this run's doing", () => {
  const result = reconcile({
    predicted: [{ path: "src/a.ts" }],
    actual: ["src/a.ts"],
    dirtyAtOpen: ["src/a.ts"],
  });

  assert.equal(result.actual, 1, "the plan claimed it, so the run owns it");
  assert.deepEqual(result.notTouched, []);
});

// ------------------------------------------------ written by kiln, in acceptance run C1

function matchingFiles(count) {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`src/f${i}.ts`, "needle\n"]));
}

function rowsOf(stdout) {
  return stdout.split("\n").filter((line) => line.includes("\t"));
}

test("a truncated blast radius says how much it dropped", () => {
  const { root } = project(matchingFiles(25));

  const { stdout } = kiln(root, ["blast", "needle"]);

  assert.equal(rowsOf(stdout).length, 20);
  assert.match(stdout, /5 more of 25 files/);
});

test("a blast radius exactly at the cap claims no truncation", () => {
  const { root } = project(matchingFiles(20));

  const { stdout } = kiln(root, ["blast", "needle"]);

  assert.equal(rowsOf(stdout).length, 20);
  assert.doesNotMatch(stdout, /more of/, "20 rows shown out of 20 is not a truncation");
});

test("the truncation notice is not mistakable for a row", () => {
  const { root } = project(matchingFiles(25));

  const notice = kiln(root, ["blast", "needle"]).stdout.split("\n").at(-2);

  assert.match(notice, /more of 25 files/);
  assert.ok(!notice.includes("\t"), "a tab would let a path parser read the notice as a file");
});

/**
 * The first real run was a superproject whose every source file lived in a submodule.
 * Root status prints one line for the whole submodule, so reconciliation reported
 * `actual 0` and then "nothing changed in this range" over a tree with edits in it.
 */
test("reconciliation sees files changed inside a submodule", () => {
  const sub = tempRoot("kiln-blast-sub-");
  initRepo(sub);
  writeFile(join(sub, "controllers", "Account.php"), "<?php\n");
  commitAll(sub, "sub first");

  const root = tempRoot("kiln-blast-super-");
  initRepo(root);
  writeFile(join(root, "README.md"), "super\n");
  commitAll(root, "super first");
  git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "AdminPage"]);
  commitAll(root, "add submodule");
  const base = git(root, ["rev-parse", "HEAD"]);

  writeFile(join(root, "AdminPage", "controllers", "Account.php"), "<?php // edited\n");
  assert.deepEqual(actualChanged(root, base), ["AdminPage/controllers/Account.php"]);

  commitAll(join(root, "AdminPage"), "edit inside the submodule");
  commitAll(root, "bump the gitlink");
  assert.deepEqual(
    actualChanged(root, base),
    ["AdminPage/controllers/Account.php"],
    "a committed submodule change is one gitlink at the superproject level",
  );
});

/**
 * The state every submodule run ends in, and the one neither half above covered: committed
 * inside the submodule, not yet recorded by the superproject. The submodule's status is then
 * clean and the superproject's is ` M AdminPage`. Measured on a real monorepo — the review
 * stage matched its rules against `AdminPage` and routed none of them, so "controllers must
 * not contain SQL" went unchecked on the commit that existed to satisfy it.
 */
test("a submodule committed ahead of its superproject still names its files", () => {
  const sub = tempRoot("kiln-blast-ahead-sub-");
  initRepo(sub);
  writeFile(join(sub, "controllers", "Genre_list.php"), "<?php\n");
  commitAll(sub, "sub first");

  const root = tempRoot("kiln-blast-ahead-super-");
  initRepo(root);
  writeFile(join(root, "README.md"), "super\n");
  commitAll(root, "super first");
  git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "AdminPage"]);
  commitAll(root, "add submodule");
  const base = git(root, ["rev-parse", "HEAD"]);

  writeFile(join(root, "AdminPage", "controllers", "Genre_list.php"), "<?php // edited\n");
  commitAll(join(root, "AdminPage"), "edit inside the submodule");
  assert.equal(git(join(root, "AdminPage"), ["status", "--short"]), "", "the submodule is clean");
  assert.match(git(root, ["status", "--short"]), /AdminPage/, "the superproject still holds the old gitlink");

  assert.deepEqual(
    actualChanged(root, base),
    ["AdminPage/controllers/Genre_list.php"],
    "the gitlink alone is not what changed",
  );

  writeFile(join(root, "AdminPage", "controllers", "Other.php"), "<?php\n");
  assert.deepEqual(
    actualChanged(root, base).sort(),
    ["AdminPage/controllers/Genre_list.php", "AdminPage/controllers/Other.php"],
    "committed-ahead and still-dirty are both true at once",
  );
});

/**
 * Measured on a real monorepo: a work opened on v3-master, whose branch was then cut from
 * another ticket's branch, reported `predicted 11 · actual 283`. `base...HEAD` is correct
 * git — merge-base to HEAD — and the merge-base was far enough back to sweep in the other
 * ticket's commits. The agent diagnosed it; nobody reading `283` would have.
 */
test("a base the branch never grew from is named, not counted from", () => {
  const { root, base } = project({ "a.txt": "a" });
  assert.equal(anchorVerdict(root, base).ok, true, "opened here, still here");

  git(root, ["checkout", "-q", "-b", "sibling"]);
  writeFile(join(root, "b.txt"), "b");
  commitAll(root, "another ticket");
  const siblingTip = git(root, ["rev-parse", "HEAD"]);

  git(root, ["checkout", "-q", "main"]);
  const verdict = anchorVerdict(root, siblingTip);
  assert.equal(verdict.ok, false, "HEAD does not descend from the sibling tip");
  assert.match(verdict.reason, /not an ancestor of HEAD/);

  const missing = anchorVerdict(root, "0".repeat(40));
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /not a commit in this checkout/);
  assert.equal(anchorVerdict(root, null).ok, true, "a work with no base yet is not off-branch");
});

/** Re-anchoring shrinks every count afterwards, so it is typed by a person and recorded. */
test("scope refuses the count, and open --base moves the anchor onto the record", () => {
  const { root } = project({ "a.txt": "a" });

  git(root, ["checkout", "-q", "-b", "other"]);
  writeFile(join(root, "b.txt"), "b");
  commitAll(root, "another ticket");
  const otherTip = git(root, ["rev-parse", "HEAD"]);

  git(root, ["checkout", "-q", "main"]);
  writeConfig(root, DEFAULTS);
  kiln(root, ["open", "w1"]);
  writeFile(join(root, "c.txt"), "c");
  commitAll(root, "my work");

  const opened = readState(root, "w1");
  writeState(root, { ...opened, base: otherTip, last_verified: otherTip });

  const refused = kiln(root, ["scope", "w1"]);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /did not grow from it/);
  assert.match(refused.stderr, /kiln open w1 --base <commit-ish>/);

  const forkPoint = git(root, ["rev-parse", "HEAD~1"]);
  assert.equal(kiln(root, ["open", "w1", "--base", forkPoint]).status, 0);

  const moved = readState(root, "w1");
  assert.equal(moved.base, forkPoint);
  assert.equal(moved.carry_over.at(-1).kind, "reanchor", "a shrinking move is on the record");
  assert.equal(kiln(root, ["scope", "w1"]).status, 0, "and the count means its sentence again");
});
