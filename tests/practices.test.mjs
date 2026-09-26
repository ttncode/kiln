import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateTrigger, loadPractices, riskFlags, selectPractices, PRACTICE_STAGES } from "../lib/practices.mjs";
import { gatherFacts } from "../lib/practices-facts.mjs";
import { loadConfig } from "../lib/config.mjs";
import { readState } from "../lib/state.mjs";
import { cleanupFixtures, commitAll, writeFile } from "./helpers/fixture.mjs";
import { kiln, monorepo, nodeProject, ok } from "./helpers/journey.mjs";

after(cleanupFixtures);

const ROOT = new URL("..", import.meta.url).pathname;
const NOTHING = { path: "bounded", auto: false, flags: null, files: null, lines: null, added: null, kinds: null };

test("D188: the plan's Risk flags — named, none, absent, misspelt or left empty", () => {
  assert.deepEqual([...riskFlags("# P\n\n## Risk flags\n- security: takes a URL from the user\n- performance: runs per row\n\n## Tasks\n")], ["security", "performance"]);
  assert.deepEqual([...riskFlags("## Risk flags\n- none\n")], []);
  assert.equal(riskFlags("# P\n\n## Tasks\n"), null, "no section is unknown, not none");
  assert.throws(() => riskFlags("## Risk flags\n- secruity: typo\n"), /name secruity; the flags are security, performance/);
  assert.throws(() => riskFlags("## Risk flags\n\n## Tasks\n"), /section is empty/);
});

test("D188: each trigger answers true, false, or unknown when code cannot tell", () => {
  const facts = { ...NOTHING, path: "full", flags: new Set(["migration"]), files: ["src/db/orders.sql", "src/app.js"], lines: 40, added: new Map([["src/app.js", "db.query(`SELECT * FROM t WHERE id = ${id}`)\n"]]), kinds: new Map([["src/app.js", "API"]]) };
  const answers = ["always", "path:full", "path:bounded", "auto", "flag:migration", "flag:security", "glob:**/*.sql", "glob:**/*.php", "content:\\$\\{", "content:eval\\(", "surface:API", "surface:SCREEN", "route:quick"].map((trigger) => evaluateTrigger(trigger, facts));
  assert.deepEqual(answers, [true, true, false, false, true, false, true, false, true, false, true, false, true]);
  assert.deepEqual(["flag:security", "glob:**/*.sql", "content:x", "surface:API", "route:quick"].map((trigger) => evaluateTrigger(trigger, NOTHING)), [null, null, null, null, null]);
  assert.throws(() => evaluateTrigger("keyword:auth", facts), /"keyword:auth" is not a trigger/);
});

test("D188: a practice is read when a trigger holds or when nothing can be decided — fire, don't skip", () => {
  const registry = [
    { id: "api", stage: "plan", file: "a.md", when: ["flag:public-api", "surface:API"] },
    { id: "ui", stage: "plan", file: "u.md", when: ["flag:ui", "glob:**/*.vue"] },
    { id: "review-only", stage: "review", file: "r.md", when: ["always"] },
  ];
  const decidedNo = { ...NOTHING, flags: new Set(), files: ["src/app.js"], kinds: new Map() };
  assert.deepEqual(selectPractices(registry, { stage: "plan", facts: decidedNo }), [], "flags say none and the files are no UI: nothing is read");
  const unknown = selectPractices(registry, { stage: "plan", facts: NOTHING }).map((practice) => practice.id);
  assert.deepEqual(unknown, ["api", "ui"], "with no plan, no files and no stack, both are read rather than skipped");
  const flagged = selectPractices(registry, { stage: "plan", facts: { ...decidedNo, flags: new Set(["public-api"]) } });
  assert.deepEqual(flagged.map((practice) => [practice.id, practice.why]), [["api", "flag:public-api"]]);
});

test("D188: agent-skills' /ship rule skips a specialist only on a small change that touches nothing sensitive", () => {
  const security = { id: "security", stage: "review", file: "s.md", when: ["always"], skip: { files_at_most: 2, lines_below: 50, unless: ["glob:**/auth/**", "content:password|token|secret"] } };
  const small = { ...NOTHING, files: ["src/format.js"], lines: 12, added: new Map([["src/format.js", "return x.trim();\n"]]) };
  assert.deepEqual(selectPractices([security], { stage: "review", facts: small }), []);
  assert.equal(selectPractices([security], { stage: "review", facts: { ...small, files: ["src/auth/login.js"] } }).length, 1, "a small change to auth is reviewed");
  assert.equal(selectPractices([security], { stage: "review", facts: { ...small, added: new Map([["src/format.js", "const token = x;\n"]]) } }).length, 1);
  assert.equal(selectPractices([security], { stage: "review", facts: { ...small, lines: 50 } }).length, 1, "50 lines is not under 50");
  assert.equal(selectPractices([security], { stage: "review", facts: { ...small, added: null } }).length, 1, "an unless code cannot decide keeps the review");
});

test("D188: the facts at REVIEW are the diff's files, its changed lines counting untracked ones, and what the lines add", () => {
  const root = nodeProject({ name: "practices" });
  ok(root, ["open", "w1", "--session", "s"]);
  writeFile(join(root, "src", "app.js"), "console.log('app');\nconst query = `SELECT * FROM t WHERE id = ${id}`;\n");
  writeFile(join(root, "src", "new.js"), "one\ntwo\nthree\n");
  const facts = gatherFacts(root, { config: loadConfig(root).config, state: readState(root, "w1"), stage: "review" });
  assert.deepEqual(facts.files, ["src/app.js", "src/new.js"]);
  assert.equal(facts.lines, 6, "app.js: one line out and two in; new.js, untracked: three");
  assert.match(facts.added.get("src/app.js"), /SELECT \* FROM t WHERE id = \$\{id\}/);
  assert.equal(facts.added.get("src/new.js"), "one\ntwo\nthree\n");
});

test("D188: kiln practices refuses a plan still being written without its Risk flags, and records what it printed", () => {
  const root = nodeProject({ name: "practices-cli" });
  ok(root, ["open", "w1", "--session", "s"]);
  assert.match(kiln(root, ["practices", "w1", "--stage", "plan", "--predicted", "src/app.js"]).stderr, /plan\.md does not exist yet/, "PLAN's practices come from the plan's flags, so the header is written first");
  writeFile(join(root, ".kiln", "work", "w1", "plan.md"), "# Plan\n\n## Tasks\n");
  const refused = kiln(root, ["practices", "w1", "--stage", "plan", "--predicted", "src/app.js"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /plan\.md has no "## Risk flags" section/);
  writeFile(join(root, ".kiln", "work", "w1", "plan.md"), "# Plan\n\n## Risk flags\n- none\n");
  const ran = kiln(root, ["practices", "w1", "--stage", "plan", "--predicted", "src/app.js"]);
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /Practices — plan · w1/);
  assert.deepEqual(readState(root, "w1").practices.map((row) => row.stage), ["plan"]);
  assert.match(kiln(root, ["practices", "w1", "--stage", "deploy"]).stderr, /usage: kiln practices <id> --stage/);
});

test("D188: every practice kiln ships names a stage, a file that exists and triggers that parse", () => {
  const practices = loadPractices(ROOT);
  assert.equal(new Set(practices.map((practice) => practice.id)).size, practices.length, "ids are unique");
  for (const practice of practices) {
    assert.ok(PRACTICE_STAGES.includes(practice.stage), `${practice.id}: stage ${practice.stage}`);
    assert.ok(existsSync(join(ROOT, practice.file)), `${practice.id}: ${practice.file} exists`);
    assert.ok(practice.when?.length > 0, `${practice.id}: has a trigger`);
    for (const trigger of [...practice.when, ...(practice.skip?.unless ?? [])]) evaluateTrigger(trigger, NOTHING);
  }
  assert.ok(Array.isArray(JSON.parse(readFileSync(join(ROOT, "skills", "practices.json"), "utf8"))));
});

test("D188: at IMPLEMENT the plan's approved files count before anything has changed", () => {
  const root = nodeProject({ name: "practices-implement" });
  ok(root, ["open", "w1", "--session", "s"]);
  writeFile(join(root, ".kiln", "work", "w1", "plan.md"), "# Plan\n\n## Risk flags\n- none\n");
  ok(root, ["gate", "w1", "plan", "--answer", "yes, approved", "--predicted", "src/app.js"]);
  const facts = gatherFacts(root, { config: loadConfig(root).config, state: readState(root, "w1"), stage: "implement" });
  assert.deepEqual(facts.files, ["src/app.js"], "nothing changed yet, so the approved prediction is what the stage works on");
  const ci = { id: "ci", stage: "implement", file: "c.md", when: ["glob:.github/workflows/**"] };
  assert.deepEqual(selectPractices([ci], { stage: "implement", facts }), [], "a decided no, not an unknown that fires");
});

test("D189: the review gate refuses until the readers were asked for, and until review.md accounts for each", () => {
  const root = nodeProject({ name: "readers-gate" });
  ok(root, ["open", "w1", "--session", "s"]);
  writeFile(join(root, ".kiln", "work", "w1", "plan.md"), "# Plan\n\n## Risk flags\n- none\n");
  ok(root, ["gate", "w1", "plan", "--answer", "yes, approved"]);
  writeFile(join(root, "src", "app.js"), "export const a = 2;\n");
  writeFile(join(root, ".kiln", "work", "w1", "review.md"), "# review\n");
  const unasked = kiln(root, ["gate", "w1", "review", "--answer", "yes, approved"]);
  assert.equal(unasked.status, 2);
  assert.match(unasked.stderr, /nothing has asked which readers this change gets/);

  const asked = ok(root, ["practices", "w1", "--stage", "review"]).stdout;
  assert.match(asked, /edge-case-hunter/);
  assert.match(asked, /diff\s+\S+review\/diff\.patch/);
  const named = readState(root, "w1").practices.find((row) => row.stage === "review").ids;
  writeFile(join(root, ".kiln", "work", "w1", "review.md"), `# review\n\nlenses: ${named.slice(1).map((name) => `${name} reported`).join(", ")}\n`);
  const partial = kiln(root, ["gate", "w1", "review", "--answer", "yes, approved"]);
  assert.equal(partial.status, 2);
  assert.match(partial.stderr, new RegExp(`does not account for ${named[0]}`));

  const wrapped = `lenses: ${named[0]} failed, ${named.slice(1).map((name) => `${name} reported`).join(", ")}.`.replace(/(.{60,79}) /g, "$1\n");
  writeFile(join(root, ".kiln", "work", "w1", "review.md"), `# review\n\n${wrapped}\n\n## Triage log\n`);
  const passed = kiln(root, ["gate", "w1", "review", "--answer", "yes, approved"]);
  assert.equal(passed.status, 0, `a failed reader is accounted for, and a line wrapped as markdown and ended with a full stop is still read: ${passed.stderr}`);
});

test("D189: the readers read one diff — untracked files in, kiln's own record out — and the claims and intent beside it", () => {
  const root = nodeProject({ name: "readers-inputs" });
  ok(root, ["open", "w1", "--session", "s"]);
  writeFile(join(root, ".kiln", "work", "w1", "brief.md"), "# Brief\nAsked: make a two.\n");
  writeFile(join(root, ".kiln", "work", "w1", "plan.md"), "# Plan\n\n**Goal:** a is two.\n\n## Risk flags\n- none\n");
  writeFile(join(root, "src", "app.js"), "export const a = 2;\n");
  writeFile(join(root, "src", "added.js"), "export const b = 3;\n");
  ok(root, ["practices", "w1", "--stage", "review"]);
  const dir = join(root, ".kiln", "tmp", "w1", "review");
  const diff = readFileSync(join(dir, "diff.patch"), "utf8");
  assert.match(diff, /\+export const a = 2;/);
  assert.match(diff, /\+export const b = 3;/, "an untracked file is part of the change");
  assert.doesNotMatch(diff, /\.kiln\//, "kiln's own record is not the change");
  assert.match(readFileSync(join(dir, "claims.md"), "utf8"), /## The plan/);
  assert.match(readFileSync(join(dir, "intent.md"), "utf8"), /Asked: make a two\.[\s\S]*\*\*Goal:\*\* a is two\./);
});

test("D190: the plan gate refuses a plan that does not say its Risk flags", () => {
  const root = nodeProject({ name: "plan-flags" });
  ok(root, ["open", "w1", "--session", "s"]);
  writeFile(join(root, ".kiln", "work", "w1", "plan.md"), "# Implementation Plan\n\n## Task List\n\n## Risks and Mitigations\n");
  const refused = kiln(root, ["gate", "w1", "plan", "--answer", "yes, approved", "--predicted", "src/app.js"]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /plan\.md has no "## Risk flags" section/);
  writeFile(join(root, ".kiln", "work", "w1", "plan.md"), "# Plan\n\n## Risk flags\n- scurity: typo\n");
  assert.match(kiln(root, ["gate", "w1", "plan", "--answer", "yes, approved"]).stderr, /name scurity/);
  writeFile(join(root, ".kiln", "work", "w1", "plan.md"), "# Plan\n\n## Risk flags\n- security: takes a query from the user\n");
  assert.equal(kiln(root, ["gate", "w1", "plan", "--answer", "yes, approved", "--predicted", "src/app.js"]).status, 0);
});

test("D199: the readers' diff holds what changed inside a submodule, and nothing that was dirty before the work opened", () => {
  const root = monorepo();
  ok(root, ["init"]);
  writeFile(join(root, "notes.txt"), "a transcript left in the tree before the work\n");
  ok(root, ["open", "w1", "--session", "s"]);
  writeFile(join(root, "AdminPage", "src", "User.php"), "<?php\n// committed inside the submodule\n");
  commitAll(join(root, "AdminPage"), "work");
  writeFile(join(root, "AdminPage", "src", "Invoice.php"), "<?php\n// new, untracked\n");
  ok(root, ["practices", "w1", "--stage", "review"]);
  const diff = readFileSync(join(root, ".kiln", "tmp", "w1", "review", "diff.patch"), "utf8");
  assert.match(diff, /AdminPage\/src\/User\.php[\s\S]*\+\/\/ committed inside the submodule/, "a commit made inside the submodule is part of the change");
  assert.match(diff, /AdminPage\/src\/Invoice\.php[\s\S]*\+\/\/ new, untracked/, "so is a file added inside it");
  assert.doesNotMatch(diff, /Subproject commit/, "the gitlink is not the change; what it points at is");
  assert.doesNotMatch(diff, /notes\.txt/, "dirty before the work opened, as kiln scope sets aside");
});
