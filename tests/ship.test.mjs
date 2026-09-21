import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DEFAULTS } from "../lib/config.mjs";
import { branchName, renderShipPlan, shipPlan } from "../lib/ship.mjs";
import { slugOfId } from "../lib/resolve.mjs";
import { newWork } from "../lib/state.mjs";
import { cleanupFixtures, commitAll, git, initRepo, tempRoot, writeFile } from "./helpers/fixture.mjs";

after(cleanupFixtures);

function monorepo() {
  const sub = initRepo(tempRoot("kiln-ship-sub-"));
  writeFile(join(sub, "src", "User.php"), "<?php\n");
  commitAll(sub, "sub");

  const root = initRepo(tempRoot("kiln-ship-super-"));
  writeFile(join(root, "README.md"), "super");
  commitAll(root, "super");
  git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", "--name", "common-models", sub, "submodules/common-models"]);
  writeFile(join(root, "AdminPage.php"), "<?php\n");
  const base = commitAll(root, "base");
  return { root, base };
}

const config = {
  repo: { kind: "multi", modules: { "common-models": "submodules/common-models" } },
  vcs: { ...DEFAULTS.vcs, integration_branch: { "common-models": "v3-develop" }, branch_pattern: "${id}" },
};

test("the diff is grouped by the repository that will carry it", () => {
  const { root, base } = monorepo();
  writeFile(join(root, "AdminPage.php"), "<?php // edited\n");
  writeFile(join(root, "submodules", "common-models", "src", "User.php"), "<?php // edited\n");

  const state = { ...newWork({ id: "w-1919", base, path: "bounded" }) };
  const plan = shipPlan(root, { config, state });

  assert.equal(plan.topic, "w-1919", "the work id is the topic, so no new concept appears");
  assert.deepEqual(plan.modules.map((row) => row.path), [".", "submodules/common-models"]);
  assert.deepEqual(plan.modules.map((row) => row.integration), ["main", "v3-develop"]);
  assert.deepEqual(plan.modules[1].files, ["submodules/common-models/src/User.php"]);
});

test("what kiln cannot promise is printed, not omitted", () => {
  const { root, base } = monorepo();
  writeFile(join(root, "AdminPage.php"), "<?php // edited\n");
  writeFile(join(root, "submodules", "common-models", "src", "User.php"), "<?php // edited\n");

  const text = renderShipPlan(shipPlan(root, { config, state: newWork({ id: "w-1919", base, path: "bounded" }) }));
  assert.match(text, /topic w-1919/);
  assert.match(text, /do not merge atomically/, "Gerrit says a topic can merge partially; so does kiln");
  assert.match(text, /the order is yours/, "no dependency order is derivable from the repositories");
});

test("a single-repository work says none of that", () => {
  const { root, base } = monorepo();
  writeFile(join(root, "AdminPage.php"), "<?php // edited\n");

  const text = renderShipPlan(shipPlan(root, { config, state: newWork({ id: "w-1", base, path: "bounded" }) }));
  assert.equal(text.includes("do not merge atomically"), false);
  assert.match(text, /1 repository/);
});

/**
 * `branch_pattern` has been in the schema since the first version and nothing rendered it.
 * A placeholder the work cannot fill is named — the same law D60.1 applies to `${cmd.x}`.
 */
test("a branch pattern the work cannot fill says so instead of shipping the placeholder", () => {
  const state = newWork({ id: "w-1", base: "abc", path: "bounded" });
  assert.equal(branchName({ vcs: { branch_pattern: "${id}" } }, state), "w-1");

  const partial = branchName({ vcs: { branch_pattern: "${type}/${id}" } }, state);
  assert.deepEqual(partial.unfilled, ["type"]);
  assert.match(renderShipPlan({ topic: "w-1", branch: partial, modules: [] }), /still contains \$\{type\}/);
});

/**
 * `slug` was filled with the id, which is not a shorthand for it. The default pattern
 * `${type}/${id}-${slug}` then produced the id twice — ninety characters of branch name,
 * with `${type}` still in it as literal text, on a real run.
 */
test("the slug is the id's descriptive tail, not the id again", () => {
  assert.equal(slugOfId("20260921-invalid-id-returns-404"), "invalid-id-returns-404");
  assert.equal(slugOfId("admin-page-20260921-invalid-id-returns-404"), "invalid-id-returns-404");
  assert.equal(slugOfId("PROJ-1919"), null, "a ticket ref has no slug to take");

  const state = { id: "20260921-invalid-id-returns-404" };
  assert.equal(branchName({ vcs: { branch_pattern: DEFAULTS.vcs.branch_pattern } }, state), state.id);
  assert.match(branchName({ vcs: { branch_pattern: "${type}/${slug}" } }, state).rendered, /\$\{type\}\/invalid-id-returns-404/);
});

test("a pattern that asks for the id and the slug is told it repeats itself", () => {
  const plan = { topic: "w", modules: [], branch: branchName({ vcs: { branch_pattern: "${id}-${slug}" } }, { id: "20260921-a-b" }) };
  assert.match(renderShipPlan(plan, "${id}-${slug}"), /already ends with the slug/);
  assert.doesNotMatch(renderShipPlan({ ...plan, branch: "x" }, "${id}"), /repeats/);
});

/**
 * `kiln scope` subtracts what was already uncommitted at open; this did not. On a real run
 * the plan listed three repositories to ship when the work touched one — the other two were
 * the user's own dirty tree, recorded in `dirty_at_open` before the work started.
 */
test("the ship plan counts this run's files, not the tree's existing dirt", () => {
  const { root, base } = monorepo();
  writeFile(join(root, "AdminPage.php"), "<?php // mine\n");
  writeFile(join(root, "Makefile"), "# theirs, and already dirty\n");
  writeFile(join(root, "submodules", "common-models", "src", "User.php"), "<?php // theirs\n");

  const state = {
    ...newWork({ id: "w-1", base, path: "bounded" }),
    dirty_at_open: ["Makefile", "submodules/common-models/src/User.php"],
    predicted: [{ path: "AdminPage.php" }],
  };
  const plan = shipPlan(root, { config, state });

  assert.deepEqual(plan.modules.map((row) => row.path), ["."], "one repository, not three");
  assert.deepEqual(plan.modules[0].files, ["AdminPage.php"]);
});

test("a file the plan claimed ships even if it was dirty at open", () => {
  const { root, base } = monorepo();
  writeFile(join(root, "AdminPage.php"), "<?php // edited\n");

  const state = {
    ...newWork({ id: "w-2", base, path: "bounded" }),
    dirty_at_open: ["AdminPage.php"],
    predicted: [{ path: "AdminPage.php" }],
  };
  assert.deepEqual(shipPlan(root, { config, state }).modules[0].files, ["AdminPage.php"], "the plan gate took responsibility for it");
});
