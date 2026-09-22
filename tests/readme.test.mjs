import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { decisionsToFirstPR } from "../scripts/decision-count.mjs";
import { cleanupFixtures, commitAll, git, initRepo, tempRoot, writeFile } from "./helpers/fixture.mjs";

after(cleanupFixtures);

const ROOT = new URL("..", import.meta.url).pathname;
const README = readFileSync(join(ROOT, "README.md"), "utf8");

function slug(heading) {
  return heading.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
}

test("every relative link in the README points at a file that exists", () => {
  const links = [...README.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)].map((m) => m[1].split("#")[0]);
  for (const target of new Set(links.filter(Boolean))) {
    assert.ok(existsSync(join(ROOT, target)), `README links to ${target}, which does not exist`);
  }
});

test("every table-of-contents anchor resolves to a heading", () => {
  const headings = new Set([...README.matchAll(/^#{2,6}\s+(.*)$/gm)].map((m) => slug(m[1])));
  for (const anchor of new Set([...README.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]))) {
    assert.ok(headings.has(anchor), `README links to #${anchor}, which is not a heading`);
  }
});

/**
 * The README quotes numbers a reader will check. Drift here is not cosmetic: it is the
 * front door claiming something the repository stopped doing.
 */
test("the README's countable claims still hold", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.match(README, /zero runtime dependencies/i);
  assert.equal(Object.keys(pkg.dependencies).length, 0);

  assert.match(README, /Node 20\.10 or newer/);
  assert.equal(pkg.engines.node, ">=20.10.0");

  const stack = JSON.parse(readFileSync(join(ROOT, "stacks", "node.json"), "utf8"));
  assert.deepEqual(stack.steps.map((s) => s.id), ["unit"], "the README prints this file verbatim");
});

/**
 * The count drifted from 203 to 239 unnoticed, because the test compared the claims it
 * could and not this one. It now lives in exactly one place: a number that has to be
 * hand-edited in two places on every test-adding PR is a maintenance cost the claim does
 * not earn, so the prose says what is true without a number and the table carries the
 * count alone.
 */
test("the README's test count matches the suite", () => {
  const dir = join(ROOT, "tests");
  const actual = readdirSync(dir)
    .filter((name) => name.endsWith(".test.mjs"))
    .reduce((sum, name) => sum + (readFileSync(join(dir, name), "utf8").match(/^test\(/gm) ?? []).length, 0);

  const claimed = Number(/\| Tests \| (\d+),/.exec(README)[1]);
  assert.equal(claimed, actual, `the status table says ${claimed}, the suite has ${actual}`);
  assert.doesNotMatch(README, /\b\d{2,4} tests\b/, "the count belongs in one place, not scattered through the prose");
});

/**
 * The claim drifted the other way once already: the opening said "has not yet been through
 * the six acceptance runs" while the status table two screens down said "6 of 6". Both
 * halves are pinned here, against the records rather than against each other.
 */
test("the README does not claim a release bar it has not met", () => {
  const latest = readFileSync(join(ROOT, "docs", "design", "2026-09-21-acceptance-c6-handover.md"), "utf8");
  assert.match(latest, /UNGRADED/, "a graded scorecard would make the rc wording the stale one");

  assert.match(README, /Status: `v1\.0\.0-rc`/);
  assert.match(README, /6 of 6/, "the runs that are done have to be visible");
  assert.doesNotMatch(README, /has not yet\s+been through the six/);
  assert.match(README, /only a person/, "the outstanding half has to stay visible");
});

/**
 * D6 puts kiln at the strictest public-repository bar. These three files are what a stranger
 * looks for before trusting code that runs inside their session, and SECURITY.md is the one
 * that matters most here: hooks are a supply-chain surface.
 */
test("the community files exist and the README routes to them", () => {
  for (const file of ["CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md"]) {
    assert.ok(existsSync(join(ROOT, file)), `${file} is missing`);
    assert.match(README, new RegExp(`\\(${file}\\)`), `the README does not link ${file}`);
  }
});

test("every relative link in the community files points at a file that exists", () => {
  for (const file of ["CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md"]) {
    const text = readFileSync(join(ROOT, file), "utf8");
    const links = [...text.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)].map((m) => m[1].split("#")[0]);
    for (const target of new Set(links.filter(Boolean))) {
      assert.ok(existsSync(join(ROOT, target)), `${file} links to ${target}, which does not exist`);
    }
  }
});

test("the README's decision count matches the decision log", () => {
  const design = readFileSync(join(ROOT, "docs", "design", "2026-09-19-kiln-architecture.md"), "utf8");
  const numbers = [...design.matchAll(/\*\*D(\d+)\*\*/g)].map((m) => Number(m[1]));
  const highest = Math.max(...numbers);
  assert.match(README, new RegExp(`${highest} decisions`), `the log runs to D${highest}`);
});

/**
 * A plugin command carries its plugin's namespace. The README's first instruction was
 * `/kiln init`, and a real user got `Unknown command: /kiln` — the documented first step
 * failing at step one, which is the whole of D6's first ten minutes.
 */
test("the documented invocation is the one that resolves", () => {
  for (const file of ["README.md", join("docs", "design", "2026-09-20-user-view.md")]) {
    const text = readFileSync(join(ROOT, file), "utf8");
    const bare = [...text.matchAll(/(?<![:\w])\/kiln(?![:\w-])/g)];
    assert.equal(bare.length, 0, `${file} tells the reader to type /kiln, which may not resolve`);
  }
});

/**
 * Auto mode was documented as the fifth bullet in the Configuration list, nine lines long
 * among one-liners, with no heading and no table-of-contents entry. A reader asking how to
 * turn it on had to read a section about the config file to find half an answer: the other
 * half, `--auto`, is typed in a request and never appears in that file.
 */
test("auto mode is findable, and says both ways to turn it on", () => {
  assert.match(README, /^## Auto mode$/m);
  assert.match(README, /\[Auto mode\]\(#auto-mode\)/, "and it is in the table of contents");

  const section = README.slice(README.indexOf("## Auto mode"), README.indexOf("## What it blocks"));
  assert.match(section, /--auto/, "the per-run lever");
  assert.match(section, /init --set auto\.bounded=true/, "and the standing one");
  assert.match(section, /config set` refuses this key/, "including the way that is deliberately not offered");
  assert.match(section, /spike/, "and what it will never do");
  assert.match(section, /kiln report/, "and where to see what it decided");
});

/** A command a reader cannot find is a command they do not have. */
test("the commands a user types are listed in one place", () => {
  assert.match(README, /^## Usage$/m);
  assert.match(README, /\[Usage\]\(#usage\)/);

  const section = README.slice(README.indexOf("## Usage"), README.indexOf("## Your first run"));
  for (const command of ["init", '"<what you want done>"', "doctor"]) {
    assert.ok(section.includes(command), `Usage never shows ${command}`);
  }
  assert.match(section, /--auto/, "the modifiers are part of how it is typed");
  assert.match(section, /kiln <verb>/, "and the verbs underneath are pointed at, not listed twice");
});

/**
 * B06, the machine half of "first-run survival": every point a user must answer between
 * `init` and their first pull request. The judgment half is a person's and cannot be
 * automated — but a release that quietly doubles the count should not be able to.
 */
test("B06: the decisions before a first PR are counted, and the README says the number", () => {
  const origin = initRepo(tempRoot("kiln-b06-origin-"));
  writeFile(join(origin, "package.json"), JSON.stringify({ name: "b06", scripts: { test: "vitest" } }));
  commitAll(origin, "first");
  const project = join(tempRoot("kiln-b06-"), "clone");
  git(process.cwd(), ["clone", "--quiet", origin, project]);

  const [bounded, full] = decisionsToFirstPR(project);

  assert.equal(bounded.path, "bounded");
  assert.match(README, new RegExp(`\\*\\*${bounded.total}\\*\\* — ${bounded.asked} questions`), `bounded costs ${bounded.total}`);
  assert.match(README, new RegExp(`${full.total} on \`full\``), `full costs ${full.total}`);
});
