import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DEFAULTS } from "../lib/config.mjs";
import { detectStack, proposeConfig } from "../lib/init.mjs";
import { detectModules, moduleFor, protectedBranchesFor } from "../lib/modules.mjs";
import { cleanupFixtures, commitAll, git, initRepo, tempRoot, writeFile } from "./helpers/fixture.mjs";

after(cleanupFixtures);

function withSubmodules(names) {
  const root = initRepo(tempRoot("kiln-mod-super-"));
  writeFile(join(root, "README.md"), "super");
  commitAll(root, "super");
  for (const [name, path] of names) {
    const sub = initRepo(tempRoot("kiln-mod-sub-"));
    writeFile(join(sub, "composer.json"), JSON.stringify({ require: { "codeigniter/framework": "3.1" } }));
    commitAll(sub, "sub");
    git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", "--name", name, sub, path]);
  }
  commitAll(root, "add submodules");
  return root;
}

test("the module set comes from git's own record, not from a hand-written list", () => {
  const root = withSubmodules([["AdminPage", "AdminPage"], ["common-models", "submodules/common-models"]]);
  assert.deepEqual(detectModules(root), { "admin-page": "AdminPage", "common-models": "submodules/common-models" });
});

test("a superproject with no manifest of its own is not an unknown stack", () => {
  const root = withSubmodules([["AdminPage", "AdminPage"]]);
  const stack = detectStack(root);
  assert.equal(stack.id, "php-ci3", "four composer.json files in the checkout, and detection said unknown");
  assert.equal(stack.evidence, "AdminPage/composer.json", "the evidence names where it was found");
});

test("init writes the modules it found", () => {
  const root = withSubmodules([["AdminPage", "AdminPage"]]);
  const { config } = proposeConfig(root);
  assert.equal(config.repo.kind, "multi");
  assert.deepEqual(config.repo.modules, { "admin-page": "AdminPage" });
});

test("a path belongs to the longest module that contains it", () => {
  const config = { repo: { modules: { helper: "submodules", "common-models": "submodules/common-models" } } };
  assert.equal(moduleFor(config, "submodules/common-models/src/User.php"), "common-models");
  assert.equal(moduleFor(config, "submodules/other/x.php"), "helper");
  assert.equal(moduleFor(config, "AdminPage/x.php"), null);
});

/**
 * D81 made `integration_branch` per module and left `protected` a single flat list, which
 * describes four checkouts correctly at most once. Deriving beats growing the schema a
 * second time: a branch kiln would open a pull request against is one it must not push to.
 */
test("every module's shipping branch is protected without being listed", () => {
  const config = {
    repo: { kind: "multi", modules: { admin: "AdminPage", models: "submodules/common-models" } },
    vcs: { protected: ["main"], integration_branch: { admin: "v3-master", models: "v3-develop" } },
  };
  assert.deepEqual(protectedBranchesFor(config).sort(), ["main", "v3-develop", "v3-master"].sort());
});

test("a single-repo config is unchanged by the derivation", () => {
  const config = { repo: { kind: "single" }, vcs: { ...DEFAULTS.vcs, protected: ["main"], integration_branch: "main" } };
  assert.deepEqual(protectedBranchesFor(config), ["main"]);
});

/**
 * Detection had two honest answers and found a dishonest one in between. Reading only the
 * root said "unknown" for a checkout with four composer.json files. Reading the modules and
 * taking the first hit said "node" for a CodeIgniter application that also builds assets —
 * worse, because "unknown" makes a user look and a wrong name makes them nod.
 */
test("a checkout that looks like two stacks says so instead of picking one", () => {
  const root = withSubmodules([["AdminPage", "AdminPage"], ["FrontEnd", "FrontEnd"]]);
  for (const path of ["AdminPage", "FrontEnd"]) {
    writeFile(join(root, path, "package.json"), JSON.stringify({ name: path, scripts: { test: "jest" } }));
  }

  const stack = detectStack(root);
  assert.deepEqual([stack.id, ...stack.alternatives].sort(), ["node", "php-ci3"], "both are offered; an exact tie has no right winner");

  const question = proposeConfig(root).questions.find((row) => row.key === "stack.id");
  assert.ok(question, "an ambiguity the user cannot see is one they cannot correct");
  assert.equal(question.options.length, 2);
});

test("the stack seen in the most modules wins, not the one checked first", () => {
  const root = withSubmodules([["a", "a"], ["b", "b"], ["c", "c"]]);
  writeFile(join(root, "a", "package.json"), JSON.stringify({ name: "a", scripts: { test: "jest" } }));

  const stack = detectStack(root);
  assert.equal(stack.id, "php-ci3", "three composer.json against one package.json");
  assert.deepEqual(stack.alternatives, ["node"]);
});

test("an unambiguous project carries no alternatives and no extra question", () => {
  const root = withSubmodules([["AdminPage", "AdminPage"]]);
  assert.deepEqual(detectStack(root).alternatives, []);
  assert.equal(proposeConfig(root).questions.find((row) => row.key === "stack.id"), undefined);
});

/**
 * CodeIgniter 3 predates composer and is normally vendored into the tree. A real project
 * turned out to have an empty `require`, and reading only the manifest called it plain
 * `php` — so the verify steps a CI3 adapter carries would never have been offered.
 */
test("a vendored framework is detected from its own files, not only from the manifest", () => {
  const root = initRepo(tempRoot("kiln-ci3-"));
  writeFile(join(root, "composer.json"), JSON.stringify({ require: {} }));
  assert.equal(detectStack(root).id, "php", "nothing says CodeIgniter yet");

  writeFile(join(root, "system", "core", "CodeIgniter.php"), "<?php\n");
  assert.equal(detectStack(root).id, "php-ci3");
});
