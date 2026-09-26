import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { matchingRules, readRoutes, rulesReport } from "../lib/rules.mjs";
import { newWork, recordRules } from "../lib/state.mjs";
import { cleanupFixtures, commitAll, git, initRepo, tempRoot, writeFile } from "./helpers/fixture.mjs";
import { loadConfig } from "../lib/config.mjs";
import { runChecks } from "../lib/doctor.mjs";
import { kiln, nodeProject, ok, state, writeReview } from "./helpers/journey.mjs";

after(cleanupFixtures);

const HEADER = "# Project rules\n\n| Trigger — a path glob | Rule file |\n|---|---|\n";

function router(rows = [], files = {}) {
  const root = tempRoot("kiln-rules-");
  writeFile(join(root, ".kiln", "rules", "index.md"), HEADER + rows.map((row) => `| ${row} |\n`).join(""));
  for (const [name, body] of Object.entries(files)) writeFile(join(root, ".kiln", "rules", name), body);
  return root;
}

const report = (root, paths, stage = "plan") => rulesReport({ root, stage, id: "w1", paths });

test("E02: a routed rule whose glob matches a file the stage names is handed over in full", () => {
  const root = router(["src/auth/** | auth.md"], { "auth.md": "Never log a token." });
  const { files, text } = report(root, ["src/auth/session.ts"]);

  assert.deepEqual(files, ["auth.md"]);
  assert.match(text, /Never log a token\./, "the rule's text is what the stage needs, not its filename");
  assert.match(text, /src\/auth\/\*\*/, "and the trigger it came from, so a wrong route is visible");
});

test("E03: a glob that matches nothing is counted, not silently absent", () => {
  const root = router(["src/auth/** | auth.md"], { "auth.md": "Never log a token." });
  const { files, text } = report(root, ["docs/readme.md"]);

  assert.deepEqual(files, []);
  assert.match(text, /1 rule\(s\) routed/, "silence would read the same as having no router at all");
  assert.match(text, /None of them match/);
});

test("E01: a project with no routed rule says so, and does not pretend to have applied any", () => {
  const root = router();
  const { files, text } = report(root, ["src/a.ts"]);

  assert.deepEqual(files, []);
  assert.match(text, /No rule is routed/);
});

test("E01: a project with no rules directory at all still answers", () => {
  const { text } = report(tempRoot("kiln-rules-"), ["src/a.ts"]);
  assert.match(text, /No rule is routed/);
});

test("E04: two triggers naming one rule hand it over once", () => {
  const root = router(["src/** | house.md", "test/** | house.md"], { "house.md": "One rule." });
  const { files } = report(root, ["src/a.ts", "test/a.spec.ts"]);
  assert.deepEqual(files, ["house.md"], "one rule to read, however many ways it was routed");
});

test("E04: two rules matching one file are both handed over", () => {
  const root = router(["src/** | a.md", "**/*.ts | b.md"], { "a.md": "A.", "b.md": "B." });
  const { files } = report(root, ["src/one.ts"]);
  assert.deepEqual(files.sort(), ["a.md", "b.md"]);
});

/**
 * The trigger column is the whole router, so the shapes a person actually types have to
 * work. A glob that only matched the exact spelling in the table would send them hunting.
 */
test("glob vocabulary: * stops at a separator, ** crosses one, and a leading ./ is the same path", () => {
  const cases = [
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/deep/a.ts", false],
    ["src/**", "src/deep/a.ts", true],
    ["**/*.sql", "db/migrations/001.sql", true],
    ["./src/**", "src/a.ts", true],
    ["src/**", "./src/a.ts", true],
    ["src/**/x.ts", "src/x.ts", true],
    ["config.json", "config.json", true],
    ["config.json", "app/config.json", false],
  ];
  for (const [trigger, path, expected] of cases) {
    const root = router([`${trigger} | r.md`], { "r.md": "R." });
    assert.equal(matchingRules(root, [path]).length === 1, expected, `${trigger} against ${path}`);
  }
});

test("E12: a trigger that looks like a regex is matched as a literal, not as a second pattern language", () => {
  const root = router(["^src/.*$ | r.md"], { "r.md": "R." });
  assert.deepEqual(matchingRules(root, ["src/a.ts"]), [], "it matches nothing, and it does not throw");
});

test("the table header is not a route", () => {
  const root = router([], { "r.md": "R." });
  assert.deepEqual(readRoutes(root).filter((row) => row.state === "route"), [], "`| Trigger | Rule file |` would route everything");
});

test("the shipped template's placeholder row is not an error", () => {
  const root = router(["_(none yet)_ | —"]);
  assert.deepEqual(readRoutes(root).map((row) => row.state), ["empty"]);
});

test("a trigger written in backticks is the same trigger", () => {
  const root = router(["`src/**` | `r.md`"], { "r.md": "R." });
  assert.equal(matchingRules(root, ["src/a.ts"]).length, 1);
});

test("E14: a stage that names no files says so, and names the way to name them", () => {
  const root = router(["src/** | r.md"], { "r.md": "R." });
  const plan = report(root, []).text;
  assert.match(plan, /No files were named/);
  assert.match(plan, /--predicted/, "a block naming nowhere to go is the shape that makes an agent invent one");
  assert.match(report(root, [], "review").text, /changed no files yet/);
});

test("E06: recording the same stage twice replaces it; two stages are two records", () => {
  const opened = newWork({ id: "w1", sessionId: "s", base: "aaa" });
  assert.deepEqual(opened.rules, [], "a new work has an empty record, not a missing one");

  const once = recordRules(opened, { stage: "plan", files: ["a.md"] });
  const twice = recordRules(once, { stage: "plan", files: ["a.md"] });
  assert.deepEqual(twice.rules, [{ stage: "plan", files: ["a.md"] }]);

  const both = recordRules(twice, { stage: "review", files: ["b.md"] });
  assert.deepEqual(both.rules.map((row) => row.stage), ["plan", "review"]);
});

/* --- the verb, in a real repository --- */

function routed(root, rows, files) {
  writeFile(join(root, ".kiln", "rules", "index.md"), HEADER + rows.map((row) => `| ${row} |\n`).join(""));
  for (const [name, body] of Object.entries(files)) writeFile(join(root, ".kiln", "rules", name), body);
  return root;
}

function opened(rows, files) {
  const root = routed(nodeProject({ name: "rules" }), rows, files);
  ok(root, ["open", "w1", "--session", "s"]);
  return root;
}

/**
 * The two stages read two different sets on purpose. A rule reaching a file the plan never
 * predicted is the case a router that only sees what is already in context cannot cover,
 * and it is also the case that matters most: unpredicted files are where a run goes wrong.
 */
/**
 * Measured on the owner's run: the plan-stage call returned "The plan names no files yet"
 * every time, because `state.predicted` is written by the **gate** (D31 — it is the
 * *approved* preview) and the router was reading it before the gate that fills it. The agent
 * diagnosed it and matched the rules by hand, routing around the verb, which is D112 a third
 * time.
 *
 * These tests wrote `predicted` straight into state.json, so they exercised a state the
 * product has no way to reach at that point in a run. They go through the verb now.
 */
test("E05: plan reads the files it is given; review reads what the diff actually touched", () => {
  const root = opened(["src/**/*.js | js.md"], { "js.md": "No console.log." });

  assert.match(ok(root, ["rules", "w1", "--stage", "plan", "--predicted", "docs/plan.md"]).stdout, /None of them match/);
  assert.match(ok(root, ["rules", "w1", "--stage", "plan", "--predicted", "src/app.js"]).stdout, /No console\.log\./,
    "the paths come from the caller, because the approved claim does not exist yet");

  writeFile(join(root, "src", "extra.js"), "console.log(1);\n");
  commitAll(root, "an unpredicted file");
  assert.match(ok(root, ["rules", "w1", "--stage", "review"]).stdout, /No console\.log\./);
});

test("E05: after the gate has claimed them, the plan stage needs no flag", () => {
  const root = opened(["src/** | js.md"], { "js.md": "No console.log." });
  writeFile(join(root, ".kiln", "work", "w1", "plan.md"), "# plan\n");
  ok(root, ["gate", "w1", "plan", "--artifact", ".kiln/work/w1/plan.md", "--answer", "1. Approve this plan as written (recommended)", "--predicted", "src/app.js"]);

  assert.match(ok(root, ["rules", "w1", "--stage", "plan"]).stdout, /No console\.log\./,
    "state.predicted is the fallback, and it is real once the gate has written it");
});

test("E06: the verb records what it handed over, so the report can say it rather than assume it", () => {
  const root = opened(["src/** | js.md"], { "js.md": "No console.log." });
  ok(root, ["rules", "w1", "--stage", "plan", "--predicted", "docs/nothing.md"]);
  assert.deepEqual(state(root, "w1").rules, [{ stage: "plan", files: [] }], "an empty hand-over is still a record of having asked");

  ok(root, ["rules", "w1", "--stage", "plan", "--predicted", "src/app.js"]);
  assert.deepEqual(state(root, "w1").rules, [{ stage: "plan", files: ["js.md"] }]);
});

test("E15: a stage kiln does not route rules for is refused, naming the ones it does", () => {
  const run = kiln(opened([], {}), ["rules", "w1", "--stage", "implement"]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /plan, review/);
});

test("E13: a work id with no state is refused by the same error every other verb uses", () => {
  const run = kiln(opened([], {}), ["rules", "nope"]);
  assert.notEqual(run.status, 0);
});

test("E19: a follow-up work starts with no rules handed over", () => {
  assert.deepEqual(newWork({ id: "w1.2", sessionId: "s", base: "aaa", follows: "w1" }).rules, [], "a reading belongs to the work that did it");
});

/* --- as a person meets it --- */

/**
 * E23. The whole feature in one run: a fresh project, one rule written and routed by hand,
 * and the rule reaching both stages. Everything before this tested a part.
 */
test("E23: a rule written after init reaches PLAN and REVIEW of the next run", () => {
  const root = nodeProject({ name: "e23" });
  ok(root, ["init"]);
  writeFile(join(root, ".kiln", "rules", "js.md"), "Never log a token.\n");
  writeFile(join(root, ".kiln", "rules", "index.md"), `${HEADER}| src/** | js.md |\n`);

  assert.equal(ok(root, ["doctor"]).stdout.includes("1 route(s), all resolved"), true, "doctor sees the route before any run does");

  ok(root, ["open", "w1", "--session", "s"]);
  const before = JSON.parse(readFileSync(join(root, ".kiln", "work", "w1", "state.json"), "utf8"));
  writeFileSync(join(root, ".kiln", "work", "w1", "state.json"), JSON.stringify({ ...before, predicted: ["src/app.js"] }));

  assert.match(ok(root, ["rules", "w1", "--stage", "plan"]).stdout, /Never log a token\./);
  writeFile(join(root, "src", "app.js"), "export const a = 2;\n");
  commitAll(root, "the change");
  assert.match(ok(root, ["rules", "w1", "--stage", "review"]).stdout, /Never log a token\./);
  assert.deepEqual(state(root, "w1").rules.map((row) => row.stage), ["plan", "review"]);
});

test("E24: a rule added part-way through a run is picked up by the next call", () => {
  const root = opened([], {});
  const before = JSON.parse(readFileSync(join(root, ".kiln", "work", "w1", "state.json"), "utf8"));
  writeFileSync(join(root, ".kiln", "work", "w1", "state.json"), JSON.stringify({ ...before, predicted: ["src/app.js"] }));
  assert.match(ok(root, ["rules", "w1"]).stdout, /No rule is routed/);

  routed(root, ["src/** | late.md"], { "late.md": "Arrived late." });
  assert.match(ok(root, ["rules", "w1"]).stdout, /Arrived late\./);
});

test("E25: a route typed wrong is caught by doctor, not discovered by its silence in a run", () => {
  const root = routed(nodeProject({ name: "e25" }), ["src/** | jss.md"], { "js.md": "R." });
  const run = kiln(root, ["doctor"]);
  assert.equal(run.status, 1, "a router that cannot resolve is a FAIL, so a wrapper can gate on it");
  assert.match(run.stdout, /jss\.md/);
  assert.match(run.stdout, /js\.md/, "and the orphan on the other side of the typo");
});

test("E26: a project whose rules directory was deleted still runs, and doctor says it is gone", () => {
  const root = opened([], {});
  rmSync(join(root, ".kiln", "rules"), { recursive: true });
  const before = JSON.parse(readFileSync(join(root, ".kiln", "work", "w1", "state.json"), "utf8"));
  writeFileSync(join(root, ".kiln", "work", "w1", "state.json"), JSON.stringify({ ...before, predicted: ["src/app.js"] }));

  assert.match(ok(root, ["rules", "w1"]).stdout, /No rule is routed/);
  assert.equal(kiln(root, ["doctor"]).status, 0, "no rules at all is a project without rules, not a broken one");
});

test("the template init writes routes nothing and resolves clean", () => {
  const root = nodeProject({ name: "template" });
  rmSync(join(root, ".kiln", "rules"), { recursive: true, force: true });
  ok(root, ["init"]);
  assert.deepEqual(readRoutes(root).map((row) => row.state), ["empty"], "the placeholder row is not a route and not an error");
  assert.match(ok(root, ["doctor"]).stdout, /0 route\(s\), all resolved/);
});

/**
 * `resolve` is string arithmetic and does not know what a symlink is. Measured on a probe
 * built for the pre-v1.0 audit: `| src/** | evil.md |` with `evil.md -> /etc/hostname`
 * resolved inside `.kiln/rules/`, doctor called the route resolved, and `kiln rules`
 * printed the machine's hostname into the run. Point the link at `.env` or a private key
 * and the router is a file-read primitive handing the contents to the agent.
 *
 * D52 settled this for writes and the reader did not get the same rule.
 */
test("E11: a rule file may not be a symlink, nor sit behind one", () => {
  const root = router(["src/** | leak.md"], {});
  const secret = join(tempRoot("kiln-rules-secret-"), "secret.txt");
  writeFile(secret, "SECRET VALUE\n");
  symlinkSync(secret, join(root, ".kiln", "rules", "leak.md"));

  assert.deepEqual(readRoutes(root).map((row) => row.state), ["escapes"]);
  const { files, text } = report(root, ["src/a.ts"]);
  assert.deepEqual(files, [], "nothing is handed over");
  assert.doesNotMatch(text, /SECRET VALUE/, "and nothing is read");
});

test("E11: a rule behind a symlinked directory is refused too", () => {
  const root = router(["src/** | theirs/x.md"], {});
  const outside = tempRoot("kiln-rules-outside-");
  writeFile(join(outside, "x.md"), "SECRET VALUE\n");
  symlinkSync(outside, join(root, ".kiln", "rules", "theirs"));

  assert.deepEqual(readRoutes(root).map((row) => row.state), ["escapes"], "refusing only the leaf leaves the directory");
  assert.doesNotMatch(report(root, ["src/a.ts"]).text, /SECRET VALUE/);
});

/* --- kiln rules add --- */

/**
 * D48 met this shape and answered it with a verb: config holds terms the run is judged by,
 * the agent may not write it, so `kiln config set` exists. After D102 a project rule sits in
 * exactly that position and had nothing on the other side — the user was told to hand-edit a
 * markdown table, and the table is where every comparable tool breaks. Cursor's
 * most-reported rules failure is a malformed file skipped in silence, and Cursor answers it
 * with `New Cursor Rule` and `/Generate Cursor Rules` rather than with documentation.
 */
function project(name) {
  const root = nodeProject({ name });
  writeFile(join(root, "AdminPage", "application", "controllers", "Agency.php"), "<?php\n");
  commitAll(root, "a controller");
  return root;
}

test("kiln rules add writes the rule and routes it in one step", () => {
  const root = project("add");
  const run = ok(root, ["rules", "add", "controllers.md", "--trigger", "**/application/controllers/**", "--text", "No SQL in the controller."]);

  assert.match(run.stdout, /created \.kiln\/rules\/controllers\.md/);
  assert.match(run.stdout, /routed .* → controllers\.md/);
  assert.match(run.stdout, /1 route\(s\), all resolved/, "the router's own check runs, so the result is not taken on trust");
  assert.equal(matchingRules(root, ["AdminPage/application/controllers/Agency.php"]).length, 1);
});

test("the row lands inside the table, not after the prose below it", () => {
  const root = project("inside");
  ok(root, ["rules", "add", "a.md", "--trigger", "**/*.php"]);
  assert.deepEqual(readRoutes(root).filter((row) => row.state === "route").map((row) => row.file), ["a.md"],
    "a row written past the table is not in the table, and would read as no route at all");
});

test("adding the same route twice is not an error and does not duplicate it", () => {
  const root = project("twice");
  ok(root, ["rules", "add", "a.md", "--trigger", "**/*.php"]);
  const again = ok(root, ["rules", "add", "a.md", "--trigger", "**/*.php"]);
  assert.match(again.stdout, /already routed/);
  assert.equal(readRoutes(root).filter((row) => row.state === "route").length, 1);
});

/**
 * Add-only is what keeps D102 intact while letting a run capture a decision: adding a rule is
 * visible in the diff and lands in a committed file; weakening one is not reachable at all.
 */
test("it adds; it never rewrites a rule that is already there", () => {
  const root = project("addonly");
  ok(root, ["rules", "add", "a.md", "--trigger", "**/*.php", "--text", "first"]);
  const run = kiln(root, ["rules", "add", "a.md", "--trigger", "**/*.js", "--text", "second"]);

  assert.equal(run.status, 1);
  assert.match(run.stderr, /never rewrites one/);
  assert.match(run.stderr, /content differs/, "so the refusal cannot be read as spurious");
  assert.match(readFileSync(join(root, ".kiln", "rules", "a.md"), "utf8"), /^first/);
});

/**
 * Measured on the owner's second validation run: they asked for the same rule again, and the
 * agent checked the file itself and skipped the verb rather than calling it — the right move,
 * because the verb would have refused. An agent routing around a verb is the same failure as
 * an agent routing around a guard, one layer up.
 */
test("asking for the same rule twice is not an error", () => {
  const root = project("twice-text");
  const args = ["rules", "add", "a.md", "--trigger", "**/*.php", "--text", "No SQL here."];
  ok(root, args);
  const again = ok(root, args);

  assert.match(again.stdout, /already says exactly this/);
  assert.match(again.stdout, /already routed/);
  assert.match(again.stdout, /the three questions/, "the questions are the point, and a no-op still asks them");
});

test("a trigger matching nothing is refused where it is cheap to fix, not reported later", () => {
  const run = kiln(project("dead"), ["rules", "add", "a.md", "--trigger", "app/does/not/exist/**"]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /matches no file git lists here/);
  assert.match(run.stderr, /repo-root relative/, "and the message shows the shape that works");
});

test("a rule file is one name ending in .md, inside .kiln/rules/", () => {
  for (const name of ["../escape.md", "notes.txt", "sub/dir.md", ".hidden.md"]) {
    const run = kiln(project("name"), ["rules", "add", name, "--trigger", "**/*.php"]);
    assert.equal(run.status, 1, `${name} was accepted`);
    assert.match(run.stderr, /cannot be a rule file/);
  }
});

/**
 * D20 mechanized two of its three questions and left the first — *can it merge into a rule
 * that already exists?* — as judgment. Judgment still needs its raw material, and the
 * material is a fact kiln can compute: which rules already cover the files this trigger
 * covers, and how many.
 *
 * The source (the marketplace this rule came from) says the quiet part that D20 kept only
 * the goal of: *every rule line is a token the agent pays on every later ticket, and the
 * longer the rules get the lower the model's compliance with each one — adding a rule to
 * force compliance can backfire.* Cursor's users arrive at the same finding from the other
 * side: past about ten always-on rules the model satisfies none of them well.
 */
test("adding a rule answers all three questions where the rule is written", () => {
  const root = project("three");
  writeFile(join(root, "AdminPage", "application", "models", "Agency_model.php"), "<?php\n");
  commitAll(root, "a model");

  ok(root, ["rules", "add", "controllers.md", "--trigger", "**/application/controllers/**"]);
  const second = ok(root, ["rules", "add", "php.md", "--trigger", "**/*.php"]);

  assert.match(second.stdout, /1\. merge\?\s+already covering these 2 file\(s\): controllers\.md \(1\)/);
  assert.match(second.stdout, /prefer editing one of those/, "question 1's own answer in the source");
  assert.match(second.stdout, /2\. flat\?\s+\d+ → \d+ lines of 200/);
  assert.match(second.stdout, /compliance falls as the total grows/, "the reason, not only the goal");
  assert.match(second.stdout, /3\. routed\?\s+yes/);
});

test("a rule nothing else covers says so, rather than staying silent", () => {
  const root = project("nomerge");
  const run = ok(root, ["rules", "add", "controllers.md", "--trigger", "**/application/controllers/**"]);
  assert.match(run.stdout, /nothing else covers these 1 file\(s\)/, "silence would read the same as not having asked");
});

test("the budget delta is measured, not asserted", () => {
  const root = project("delta");
  ok(root, ["rules", "add", "a.md", "--trigger", "**/*.php", "--text", "one\ntwo\nthree"]);
  const run = ok(root, ["rules", "add", "b.md", "--trigger", "**/*.php", "--text", "four"]);
  const [, before, after] = /(\d+) → (\d+) lines/.exec(run.stdout);
  assert.ok(Number(after) > Number(before), `adding lines has to move the number: ${before} → ${after}`);
});

/**
 * Measured on a real monorepo, on the owner's validation run. A rule routed to
 * `**\/application/controllers/**` was reported by doctor as matching no file here — and the
 * rule fires perfectly well: `kiln rules` matches the paths a stage names, and those come
 * from `actualChanged`, which walks the submodules.
 *
 * `git ls-files` at a superproject lists a submodule as **one gitlink entry** — `AdminPage`,
 * not its 71 controllers. So the dead-route check was blind to exactly the code kiln was
 * installed to guard, and on that project the warning would have stood for every rule anyone
 * ever wrote. A warning that is always wrong is a warning people stop reading — D89's own
 * finding, one instrument over.
 *
 * Worse in rc.24, which this run predates: `kiln rules add` refuses a glob matching nothing
 * git lists, so the very rule the owner needed would have been refused outright.
 */
function superproject() {
  const inner = initRepo(tempRoot("kiln-sub-"));
  writeFile(join(inner, "application", "controllers", "Account.php"), "<?php\n");
  commitAll(inner, "a controller");

  const root = initRepo(tempRoot("kiln-super-"));
  writeFile(join(root, "README.md"), "super\n");
  commitAll(root, "super");
  git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "AdminPage"]);
  commitAll(root, "add AdminPage");
  writeFile(join(root, ".kiln", "config.json"), JSON.stringify({ schema_version: 1, stack: { id: "node", cmd: { test: "true" }, steps: [{ id: "unit", run: "${cmd.test}" }] } }, null, 2));
  writeFile(join(root, ".kiln", "rules", "index.md"), HEADER);
  return root;
}

test("a submodule's files are not invisible to the router's checks", () => {
  const root = superproject();
  assert.equal(git(root, ["ls-files"]).includes("application/controllers"), false,
    "the superproject lists the submodule as one gitlink entry — this is the trap");

  writeFile(join(root, ".kiln", "rules", "sql.md"), "No SQL in controllers.\n");
  writeFile(join(root, ".kiln", "rules", "index.md"), `${HEADER}| **/application/controllers/** | sql.md |\n`);

  const routing = runChecks(root, loadConfig(root)).filter((row) => row.title === "rules routing");
  assert.deepEqual(routing.map((row) => row.status), ["ok"], `a live route reported as dead: ${JSON.stringify(routing)}`);
});

/**
 * Two runs reached REVIEW. The first called `kiln rules --stage review`; the second did not,
 * and nothing noticed — a coin flip on the one claim D101 makes that nothing else covers: a
 * rule reaching a file **the plan never predicted**.
 *
 * D20's evidence is that this is how prose ends, and it is measured rather than argued — the
 * repository that authored the rule-budget law violated it 28 times because it was prose and
 * not a gate. So the review gate asks.
 */
function atReview(rows, files) {
  const root = routed(nodeProject({ name: `gate-${Object.keys(files).join("-") || "bare"}` }), rows, files);
  ok(root, ["open", "w1", "--session", "s"]);
  writeReview(root, "w1");
  return root;
}

const recordReview = (root) =>
  kiln(root, ["gate", "w1", "review", "--artifact", ".kiln/work/w1/review.md", "--answer", "1. Approve this review (recommended)"]);

test("the review gate refuses until the diff has been matched against the rules", () => {
  const root = atReview(["src/** | js.md"], { "js.md": "No console.log." });

  const refused = recordReview(root);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /nothing has matched this run's diff/);
  assert.match(refused.stderr, /kiln rules w1 --stage review/, "and it names the command that clears it");

  ok(root, ["rules", "w1", "--stage", "review"]);
  assert.equal(recordReview(root).status, 0, "asked and answered, the gate records");
});

/**
 * A precondition that buys nothing is friction the next person routes around — which is the
 * failure this whole line of decisions is about.
 */
test("a project that has routed no rule is not asked", () => {
  assert.equal(recordReview(atReview([], {})).status, 0);
});

test("the plan gate is not asked — its call shapes a document the user is about to read", () => {
  const root = atReview(["src/** | js.md"], { "js.md": "No console.log." });
  writeFile(join(root, ".kiln", "work", "w1", "plan.md"), "# plan\n");
  const run = kiln(root, ["gate", "w1", "plan", "--artifact", ".kiln/work/w1/plan.md", "--answer", "1. Approve this plan as written (recommended)"]);
  assert.equal(run.status, 0);
});
