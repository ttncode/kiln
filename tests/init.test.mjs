import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyInit, detectStack, detectVcs, gitOutput, planInit, proposeConfig, unsatisfiedSteps } from "../lib/init.mjs";
import { cleanupFixtures, commitAll, initRepo, tempRoot, writeFile } from "./helpers/fixture.mjs";

after(cleanupFixtures);

function nodeProject(scripts = { test: "vitest run" }) {
  const root = tempRoot();
  writeFile(join(root, "package.json"), JSON.stringify({ name: "app", scripts }));
  return root;
}

test("B01: a node project is detected from package.json", () => {
  const stack = detectStack(nodeProject());
  assert.equal(stack.id, "node");
  assert.equal(stack.cmd.test, "npm test");
  assert.equal(stack.evidence, "package.json");
});

test("D40: no lint step is invented, and one is adopted when the project has it", () => {
  assert.equal("lint" in detectStack(nodeProject()).cmd, false);
  assert.equal(detectStack(nodeProject({ test: "x", lint: "biome check" })).cmd.lint, "npm run lint");
});

test("a typecheck step appears only when a tsconfig does", () => {
  const root = nodeProject();
  assert.equal("typecheck" in detectStack(root).cmd, false);
  writeFile(join(root, "tsconfig.json"), "{}");
  assert.equal(detectStack(root).cmd.typecheck, "tsc --noEmit");
});

test("CodeIgniter is told apart from plain PHP by what it requires", () => {
  const ci3 = tempRoot();
  writeFile(join(ci3, "composer.json"), JSON.stringify({ require: { "codeigniter/framework": "3.1" } }));
  assert.equal(detectStack(ci3).id, "php-ci3");

  const php = tempRoot();
  writeFile(join(php, "composer.json"), JSON.stringify({ require: { "monolog/monolog": "3.0" } }));
  assert.equal(detectStack(php).id, "php");
});

test("an unrecognised project still yields a usable stack rather than an error", () => {
  const stack = detectStack(tempRoot());
  assert.equal(stack.id, "unknown");
  assert.deepEqual(stack.cmd, {});
});

test("D60.5: detection works in a directory with no git at all", () => {
  const root = tempRoot();
  assert.equal(gitOutput(root, ["rev-parse", "HEAD"]), null, "git failure is a value, not a throw");
  assert.equal(detectVcs(root).integration_branch, "main", "the built-in default stands in");
});

test("D60.5: a repository with no commit yet still initialises", () => {
  const root = initRepo(nodeProject());
  const { config } = proposeConfig(root);
  assert.equal(config.vcs.integration_branch, "main");
  assert.deepEqual(applyInit(root, config).kept, []);
});

test("an unborn branch is read by name, so protected guards the branch that exists", () => {
  const root = nodeProject();
  gitOutput(root, ["init", "--quiet", "--initial-branch=v3-master"]);

  const vcs = detectVcs(root);
  assert.equal(vcs.integration_branch, "v3-master", "no commit yet, but the branch is named");
  assert.deepEqual(vcs.protected, ["v3-master"]);
});

test("the integration branch is read from the checkout, not assumed to be main", () => {
  const root = initRepo(nodeProject());
  writeFile(join(root, "a.txt"), "a");
  commitAll(root, "first");
  gitOutput(root, ["checkout", "-q", "-b", "v3-master"]);

  const vcs = detectVcs(root);
  assert.equal(vcs.integration_branch, "v3-master");
  assert.deepEqual(vcs.protected, ["v3-master"], "the branch kiln ships to is the branch it protects");
});

test("the tracker provider follows the remote rather than a hardcoded default", () => {
  const root = initRepo(nodeProject());
  gitOutput(root, ["remote", "add", "origin", "https://gitlab.com/acme/app.git"]);
  assert.equal(proposeConfig(root).config.tracker.provider, "gitlab");
});

test("B01: init asks at most three questions, and every one carries a default", () => {
  const { questions } = proposeConfig(nodeProject());
  assert.ok(questions.length <= 3, `asked ${questions.length}`);
  for (const question of questions) {
    assert.notEqual(question.default, undefined, `${question.key} has no default`);
  }
});

test("B02: init asks for no token, no Docker, no Python and no CI", () => {
  const asked = JSON.stringify(proposeConfig(nodeProject()).questions).toLowerCase();
  for (const forbidden of ["token", "docker", "python", " ci ", "api key", "password"]) {
    assert.equal(asked.includes(forbidden), false, `init asked about ${forbidden.trim()}`);
  }
});

test("B01: init writes the config, the rules router and the tmp ignore", () => {
  const root = nodeProject();
  const { config } = proposeConfig(root);
  const { written } = applyInit(root, config);

  assert.equal(written.length, 3);
  assert.match(readFileSync(join(root, ".kiln", "rules", "index.md"), "utf8"), /Unrouted is dead weight/);
  assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /^\.kiln\/tmp\/$/m);
});

test("B03: a second init overwrites nothing and reports what it kept", () => {
  const root = nodeProject();
  const { config } = proposeConfig(root);
  applyInit(root, config);
  writeFileSync(join(root, ".kiln", "config.json"), '{"artifact_language":"vi"}\n', "utf8");

  const again = applyInit(root, { ...config, artifact_language: "en" });

  assert.deepEqual(again.written, [], "nothing was rewritten");
  assert.equal(again.kept.length, 3);
  assert.match(readFileSync(join(root, ".kiln", "config.json"), "utf8"), /"vi"/, "the user's edit survives");
});

test("B03: planInit reports what exists before anything is written", () => {
  const root = nodeProject();
  writeFile(join(root, ".gitignore"), "node_modules/\n");

  const before = planInit(root);
  assert.deepEqual(before.existing.map((t) => t.kind), ["gitignore"]);
  assert.deepEqual(before.missing.map((t) => t.kind), ["config", "rules"]);
});

test("the tmp ignore is appended to an existing .gitignore, never substituted for it", () => {
  const root = nodeProject();
  writeFile(join(root, ".gitignore"), "node_modules/\ndist/\n");
  applyInit(root, proposeConfig(root).config);

  const lines = readFileSync(join(root, ".gitignore"), "utf8").split("\n").filter(Boolean);
  assert.deepEqual(lines, ["node_modules/", "dist/", ".kiln/tmp/"]);
});

test("the tmp ignore is not appended twice", () => {
  const root = nodeProject();
  const { config } = proposeConfig(root);
  applyInit(root, config);
  applyInit(root, config);

  const hits = readFileSync(join(root, ".gitignore"), "utf8").split("\n").filter((l) => l === ".kiln/tmp/");
  assert.equal(hits.length, 1);
});

test("D40: init writes the steps it can satisfy, and no others", () => {
  const plain = proposeConfig(nodeProject());
  assert.deepEqual(plain.config.stack.steps.map((s) => s.id), ["unit"], "a plain JS project has no typecheck");

  const typed = nodeProject({ test: "vitest run", lint: "biome check" });
  writeFile(join(typed, "tsconfig.json"), "{}");
  assert.deepEqual(proposeConfig(typed).config.stack.steps.map((s) => s.id), ["typecheck", "lint", "unit"]);
});

test("B02: a plain JS project is Ready out of the box, with nothing to fix first", () => {
  const { config } = proposeConfig(nodeProject());
  assert.deepEqual(unsatisfiedSteps({ steps: config.stack.steps }, config.stack.cmd), []);
});
