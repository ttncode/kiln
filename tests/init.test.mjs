import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyInit, detectStack, detectVcs, gitOutput, planInit, proposeConfig, unsatisfiedSteps } from "../lib/init.mjs";
import { cleanupFixtures, commitAll, git, initRepo, tempRoot, writeFile } from "./helpers/fixture.mjs";

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

/**
 * Only a stack kiln can load may be named. Plain PHP detected as `php`, `init` wrote it,
 * and `kiln doctor` failed with `no stack named "php"` — a config that cannot work,
 * produced by the command whose job is to produce one that does.
 */
test("CodeIgniter is told apart from plain PHP, and only the one with an adapter is named", () => {
  const ci3 = tempRoot();
  writeFile(join(ci3, "composer.json"), JSON.stringify({ require: { "codeigniter/framework": "3.1" } }));
  assert.equal(detectStack(ci3).id, "php-ci3");

  const php = tempRoot();
  writeFile(join(php, "composer.json"), JSON.stringify({ require: { "monolog/monolog": "3.0" } }));
  assert.equal(detectStack(php).id, "unknown", "kiln ships no php.json, so it does not name one");
  assert.deepEqual(detectStack(php).alternatives, [], "and does not offer it as a choice either");
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

/**
 * D92 replaced a fixed three with "ask what detection cannot answer". The count is not the
 * law — not interrogating the user is — and on a real setup the fixed three did not reduce
 * the questions, it moved them into `kiln doctor` after the file was already written.
 */
test("B01: init asks only what it cannot detect, and every question carries a default", () => {
  const { questions } = proposeConfig(nodeProject());
  assert.deepEqual(
    questions.map((row) => row.key).sort(),
    ["stack.cmd.test", "tracker.provider", "vcs.integration_branch", "vcs.protected"],
    "no remote here, so the forge and the default branch are both unreadable",
  );
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

test("D7 item 1: the integration branch is what the repo ships from, not where you stand", () => {
  const root = initRepo(nodeProject());
  writeFile(join(root, "a.txt"), "a");
  commitAll(root, "first");
  gitOutput(root, ["remote", "add", "origin", "https://github.com/acme/app.git"]);
  gitOutput(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  gitOutput(root, ["checkout", "-q", "-b", "feat/trying-kiln-out"]);

  const vcs = detectVcs(root);
  assert.equal(vcs.integration_branch, "main", "running init from a branch must not protect that branch");
  assert.deepEqual(vcs.protected, ["main"], "otherwise a push to main is allowed on every real repository");
});

test("with no remote, the branch you are on is the best answer there is", () => {
  const root = initRepo(nodeProject());
  writeFile(join(root, "a.txt"), "a");
  commitAll(root, "first");
  gitOutput(root, ["checkout", "-q", "-b", "v3-master"]);

  assert.equal(detectVcs(root).integration_branch, "v3-master");
});

/**
 * The config a real setup run produced: both commands answered through `--set`, and
 * `"steps": []` written beside them, because the derivation ran inside proposeConfig
 * before any override was read. `kiln verify` then reported green over the empty list.
 */
test("--set stack.cmd.* reaches the step list", () => {
  const root = initRepo(tempRoot("kiln-init-set-"));
  writeFile(join(root, "composer.json"), JSON.stringify({ require: { "codeigniter/framework": "3.1" } }));
  const bin = new URL("../bin/kiln.mjs", import.meta.url).pathname;
  const run = spawnSync(
    process.execPath,
    [bin, "init", "--set", "stack.id=php-ci3", "--set", "stack.cmd.test=make test", "--set", "stack.cmd.migrate=curl -sf http://localhost/admin/migrate"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);

  const written = JSON.parse(readFileSync(join(root, ".kiln", "config.json"), "utf8"));
  assert.deepEqual(written.stack.steps.map((step) => step.id), ["migrate", "unit"], "the adapter's own steps, both satisfiable");
});

test("a step the commands cannot satisfy is not written", () => {
  const root = initRepo(tempRoot("kiln-init-partial-"));
  writeFile(join(root, "composer.json"), JSON.stringify({ require: { "codeigniter/framework": "3.1" } }));
  const bin = new URL("../bin/kiln.mjs", import.meta.url).pathname;
  spawnSync(process.execPath, [bin, "init", "--set", "stack.id=php-ci3", "--set", "stack.cmd.test=make test"], { cwd: root, encoding: "utf8" });

  const written = JSON.parse(readFileSync(join(root, ".kiln", "config.json"), "utf8"));
  assert.deepEqual(written.stack.steps.map((step) => step.id), ["unit"], "migrate needs cmd.migrate, which nobody set");
});

test("init --help says what init does instead of doing it", () => {
  const root = initRepo(tempRoot("kiln-init-help-"));
  const bin = new URL("../bin/kiln.mjs", import.meta.url).pathname;
  const run = spawnSync(process.execPath, [bin, "init", "--help"], { cwd: root, encoding: "utf8" });

  assert.equal(run.status, 0);
  assert.equal(existsSync(join(root, ".kiln")), false, "it wrote a whole .kiln/ into the plugin's own cache on a real run");
});

/**
 * On the first real setup, `init` was run bare and every question it had prepared went
 * unasked. `kiln doctor` then came back and asked the same things after the file was on
 * disk — including which branch pull requests target, which is a safety answer.
 */
test("init names what it decided for you when nobody answered", () => {
  const root = initRepo(tempRoot("kiln-init-unasked-"));
  const bin = new URL("../bin/kiln.mjs", import.meta.url).pathname;
  const run = spawnSync(process.execPath, [bin, "init"], { cwd: root, encoding: "utf8" });

  assert.equal(run.status, 0, "a project kiln cannot identify is a supported starting point");
  assert.match(run.stdout, /kiln decided these for you/);
  assert.match(run.stdout, /vcs\.protected/);
  assert.doesNotMatch(run.stdout, /stack\.id/, "only one stack is detectable here, so there is nothing to ask");
});

test("an answered question is not reported as decided for you", () => {
  const root = initRepo(tempRoot("kiln-init-answered-"));
  writeFile(join(root, "package.json"), JSON.stringify({ name: "a", scripts: { test: "vitest run" } }));
  const bin = new URL("../bin/kiln.mjs", import.meta.url).pathname;
  const run = spawnSync(process.execPath, [bin, "init", "--set", "tracker.provider=gitlab"], { cwd: root, encoding: "utf8" });

  assert.doesNotMatch(run.stdout, /tracker\.provider =/);
  assert.match(run.stdout, /vcs\.protected/);
});

/**
 * A superproject often has no remote of its own — every one belongs to a submodule. Reading
 * only the root answered `github` and `main` for a checkout whose modules all live on a
 * GitLab host, and doctor had to correct both after the fact.
 */
test("the remote is read from a module when the superproject has none", () => {
  const sub = initRepo(tempRoot("kiln-init-vcssub-"));
  writeFile(join(sub, "a.txt"), "a");
  commitAll(sub, "sub");

  const root = initRepo(tempRoot("kiln-init-vcssuper-"));
  writeFile(join(root, "README.md"), "super");
  commitAll(root, "super");
  git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "AdminPage"]);
  commitAll(root, "add submodule");

  // The checkout git created is its own working tree; the remote belongs to that one.
  const checkout = join(root, "AdminPage");
  git(checkout, ["remote", "set-url", "origin", "git@gitlab.example.jp:team/app.git"]);
  git(checkout, ["update-ref", "refs/remotes/origin/v3-develop", "HEAD"]);
  git(checkout, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/v3-develop"]);

  const vcs = detectVcs(root);
  assert.equal(vcs.provider, "gitlab", "the superproject has no remote; the module does");
  assert.equal(vcs.integration_branch, "v3-develop");
  assert.equal(vcs.guessed, false);
});

test("a branch nothing names is marked a guess, so init can ask instead of pretending", () => {
  const root = initRepo(tempRoot("kiln-init-guess-"));
  writeFile(join(root, "a.txt"), "a");
  commitAll(root, "first");

  assert.equal(detectVcs(root).guessed, true, "origin/HEAD is unset, so the branch you stand on is not a fact");
  const asked = proposeConfig(root).questions.map((row) => row.key);
  assert.ok(asked.includes("vcs.integration_branch"));
});
