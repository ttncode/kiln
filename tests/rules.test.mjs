import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { matchingRules, readRoutes, rulesReport } from "../lib/rules.mjs";
import { newWork, openNextPass, recordRules } from "../lib/state.mjs";
import { cleanupFixtures, commitAll, tempRoot, writeFile } from "./helpers/fixture.mjs";
import { kiln, nodeProject, ok, state } from "./helpers/journey.mjs";

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

test("E14: a stage that names no files says so, rather than reporting that no rule applied", () => {
  const root = router(["src/** | r.md"], { "r.md": "R." });
  assert.match(report(root, []).text, /names no files yet/);
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
test("E05: plan reads what the plan predicted; review reads what the diff actually touched", () => {
  const root = opened(["src/**/*.js | js.md"], { "js.md": "No console.log." });

  const before = JSON.parse(readFileSync(join(root, ".kiln", "work", "w1", "state.json"), "utf8"));
  writeFileSync(join(root, ".kiln", "work", "w1", "state.json"), JSON.stringify({ ...before, predicted: ["docs/plan.md"] }));

  assert.match(ok(root, ["rules", "w1", "--stage", "plan"]).stdout, /None of them match/);

  writeFile(join(root, "src", "extra.js"), "console.log(1);\n");
  commitAll(root, "an unpredicted file");
  assert.match(ok(root, ["rules", "w1", "--stage", "review"]).stdout, /No console\.log\./);
});

test("E06: the verb records what it handed over, so the report can say it rather than assume it", () => {
  const root = opened(["src/** | js.md"], { "js.md": "No console.log." });
  ok(root, ["rules", "w1", "--stage", "plan"]);
  assert.deepEqual(state(root, "w1").rules, [{ stage: "plan", files: [] }], "an empty hand-over is still a record of having asked");

  const before = JSON.parse(readFileSync(join(root, ".kiln", "work", "w1", "state.json"), "utf8"));
  writeFileSync(join(root, ".kiln", "work", "w1", "state.json"), JSON.stringify({ ...before, predicted: ["src/app.js"] }));
  ok(root, ["rules", "w1", "--stage", "plan"]);
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

test("E19: a new pass clears what the previous pass was handed", () => {
  const shipped = recordRules(newWork({ id: "w1", sessionId: "s", base: "aaa" }), { stage: "plan", files: ["a.md"] });
  assert.deepEqual(openNextPass(shipped, "bbb").rules, [], "an approval belongs to the pass that earned it, and so does a rule reading");
});
