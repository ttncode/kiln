import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "../lib/config.mjs";
import { branchName, isBranchName, renderShipPlan, shipPlan } from "../lib/ship.mjs";
import { refOfId, slugOfId } from "../lib/resolve.mjs";
import { newWork } from "../lib/state.mjs";
import { cleanupFixtures, commitAll, git, initRepo, tempRoot, writeConfig, writeFile } from "./helpers/fixture.mjs";
import { kiln, nodeProject, ok, state, throughPlanGate, writeReview } from "./helpers/journey.mjs";

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
/**
 * `${type}` is fillable now, so the unfillable one is `${slug}`: a ticket-ref id has no
 * descriptive tail to take, and inventing one is what produced a ninety-character branch
 * name the first time.
 */
test("a branch pattern the work cannot fill says so instead of shipping the placeholder", () => {
  const state = newWork({ id: "PROJ-1919", base: "abc", path: "bounded", type: "fix" });
  assert.equal(branchName({ vcs: { branch_pattern: "${type}/${id}" } }, state), "fix/PROJ-1919");

  const partial = branchName({ vcs: { branch_pattern: "${type}/${slug}" } }, state);
  assert.deepEqual(partial.unfilled, ["slug"]);
  assert.match(renderShipPlan({ topic: "PROJ-1919", branch: partial, modules: [] }), /still contains \$\{slug\}/);
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

  const state = newWork({ id: "20260921-invalid-id-returns-404", base: "a", type: "fix" });
  assert.equal(branchName({ vcs: { branch_pattern: "${id}" } }, state), state.id);
  assert.equal(branchName({ vcs: { branch_pattern: "${type}/${slug}" } }, state), "fix/invalid-id-returns-404");
});

test("D172: ${ref} is the tracker's ref, so feature/v3/#${ref} renders feature/v3/#1586", () => {
  assert.equal(refOfId("admin-page-1586"), "1586");
  assert.equal(refOfId("SE-5236.2"), "SE-5236", "a follow-up renders its ticket's ref");
  assert.equal(refOfId("admin-page-SE-5236"), "SE-5236");
  assert.equal(refOfId("20260921-fix-issue-42"), null, "a sentence's id has no ref, even one ending in a number");

  const pattern = "feature/v3/#${ref}";
  assert.equal(branchName({ vcs: { branch_pattern: pattern } }, { id: "admin-page-1586" }), "feature/v3/#1586");
  assert.deepEqual(branchName({ vcs: { branch_pattern: pattern } }, { id: "20260921-a-b" }).unfilled, ["ref"]);
});

test("D172: a branch name git refuses is named at ship, not at git switch", () => {
  assert.equal(isBranchName("feature/v3/#1586"), true);
  assert.equal(isBranchName("feature/v3/a b"), false);
  for (const refused of ["-foo", "--help", "HEAD"]) assert.equal(isBranchName(refused), false, `${refused} is a ref name but not a branch`);
  assert.match(renderShipPlan({ topic: "w", modules: [], branch: "feature/a..b" }), /git refuses "feature\/a\.\.b"/);
  assert.doesNotMatch(renderShipPlan({ topic: "w", modules: [], branch: "feature/v3/#1586" }), /git refuses/);
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

/**
 * `${type}` was in the default pattern and could not be filled, so #59 removed it along
 * with the doubling it was next to — and took the namespace with it. Three real runs then
 * put branches like `20260922-route-…` beside `main` and `develop`, in a repository whose
 * own convention is `feature/v3/#1352`.
 *
 * Conventional Commits already owns this vocabulary; kiln does not invent one.
 */
test("a branch carries its change type as a namespace", () => {
  const pattern = { vcs: { branch_pattern: DEFAULTS.vcs.branch_pattern } };
  const work = (type) => newWork({ id: "20260922-account-edit-returns-500", base: "a", type });

  assert.equal(branchName(pattern, work("fix")), "fix/20260922-account-edit-returns-500");
  assert.equal(branchName(pattern, work(undefined)), "chore/20260922-account-edit-returns-500", "the standard's catch-all says the least");
  assert.equal(DEFAULTS.vcs.branch_pattern, "${type}/${id}");
});

test("a type kiln does not know is refused at open, not discovered at ship", () => {
  const root = initRepo(tempRoot("kiln-type-"));
  writeFile(join(root, "a.txt"), "a");
  commitAll(root, "first");
  writeConfig(root, DEFAULTS);
  writeFile(join(root, ".kiln", "rules", "index.md"), "# rules\n");

  const bin = new URL("../bin/kiln.mjs", import.meta.url).pathname;
  const run = spawnSync(process.execPath, [bin, "open", "w1", "--type", "hotfix"], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /"hotfix" is not a change type/);
  assert.match(run.stderr, /feat, fix, chore/);
});

/**
 * `reviewed` and `shipped` were read by `resolve.mjs` and written by nothing. D24's resume
 * table described three states and the product could reach one, so every work stayed
 * `in_progress` for ever — and with it the claim its `predicted[]` holds, which `claimOwner`
 * checks only against **active** works. A file touched once was claimed permanently, and the
 * next work touching it halted at its plan gate naming a run that had finished days ago.
 *
 * Found while writing instructions for three runs of one ticket: runs two and three would
 * have halted against run one, and the conflict would have been correct machinery firing on
 * a finished work.
 */
test("approving the gate that authorises shipping leaves the work reviewed", () => {
  const root = nodeProject({ name: "reviewed" });
  ok(root, ["init"]);
  ok(root, ["open", "w1", "--session", "s", "--path", "bounded"]);
  writeReview(root, "w1");

  ok(root, ["gate", "w1", "review", "--artifact", ".kiln/work/w1/review.md", "--answer", "1. Approve this review (recommended)"]);
  assert.equal(state(root, "w1").status, "reviewed", "on bounded, accept is accept-and-ship");
});

test("a work stops claiming its files once the pull requests exist", () => {
  const root = nodeProject({ name: "shipped" });
  ok(root, ["init"]);
  ok(root, ["open", "w1", "--session", "s"]);
  writeFile(join(root, ".kiln", "work", "w1", "plan.md"), "# plan\n");
  ok(root, ["gate", "w1", "plan", "--artifact", ".kiln/work/w1/plan.md", "--answer", "1. Approve this plan as written (recommended)", "--predicted", "src/app.js"]);

  ok(root, ["open", "w2", "--session", "s2"]);
  writeFile(join(root, ".kiln", "work", "w2", "plan.md"), "# plan\n");
  const blocked = kiln(root, ["gate", "w2", "plan", "--artifact", ".kiln/work/w2/plan.md", "--answer", "1. Approve this plan as written (recommended)", "--predicted", "src/app.js"]);
  assert.equal(blocked.status, 2, "D72: two works cannot claim one path");
  assert.match(blocked.stderr, /w1/, "and the conflict names the owner");

  writeReview(root, "w1");
  ok(root, ["gate", "w1", "review", "--answer", "1. Approve this review as written (recommended)"]);
  const shipped = ok(root, ["ship", "w1", "--opened", "https://example.invalid/mr/1"]);
  assert.match(shipped.stdout, /claims no files now/);
  assert.equal(state(root, "w1").status, "shipped");
  assert.deepEqual(state(root, "w1").opened, ["https://example.invalid/mr/1"]);

  assert.equal(kiln(root, ["gate", "w2", "plan", "--artifact", ".kiln/work/w2/plan.md", "--answer", "1. Approve this plan as written (recommended)", "--predicted", "src/app.js"]).status, 0,
    "a finished work is not a conflict");
});

test("ship without --opened still only prints, and changes nothing", () => {
  const root = nodeProject({ name: "printonly" });
  ok(root, ["init"]);
  ok(root, ["open", "w1", "--session", "s"]);
  ok(root, ["ship", "w1"]);
  assert.equal(state(root, "w1").status, "in_progress", "printing a plan is not evidence anything was opened");
});

/**
 * Every sandbox refusal tells the run its temp files are removed when ship records the work
 * shipped. Nothing removed them — a real run ended with the directory still there, and its
 * own session could no longer delete it. A promise kiln makes in a message is kiln's to keep.
 */
test("shipping removes the scratch tree the sandbox told the run to use", () => {
  const root = nodeProject({ name: "scratch" });
  ok(root, ["init"]);
  ok(root, ["open", "w1", "--session", "s"]);
  writeFile(join(root, ".kiln", "tmp", "w1", "steps", "1.log"), "output\n");
  writeFile(join(root, ".kiln", "work", "w1", "plan.md"), "# plan\n");
  ok(root, ["gate", "w1", "plan", "--answer", "yes, approved"]);
  writeReview(root, "w1");
  ok(root, ["gate", "w1", "review", "--answer", "yes, approved"]);

  ok(root, ["ship", "w1", "--opened", "https://example.invalid/mr/1"]);
  assert.equal(existsSync(join(root, ".kiln", "tmp", "w1")), false);
});

test("a ship that records nothing removes nothing", () => {
  const root = nodeProject({ name: "scratch-kept" });
  ok(root, ["init"]);
  ok(root, ["open", "w1", "--session", "s"]);
  writeFile(join(root, ".kiln", "tmp", "w1", "steps", "1.log"), "output\n");

  ok(root, ["ship", "w1"]);
  assert.equal(existsSync(join(root, ".kiln", "tmp", "w1")), true, "the work is not shipped, so the run is not over");
});

/**
 * `--opened`'s help read "The work is shipped, and stops claiming the files it predicted."
 * The first half is true and the second is one step late: `activeWorks` is `in_progress` or
 * `halted`, so the claim is released when the review gate makes the work `reviewed`.
 *
 * On a real run the agent read that line, believed it, and told the user twice that a
 * finished work was still holding a file it had already let go. A sentence about a
 * consequence that is already false travels further than a wrong remedy: the agent repeats
 * it in its own words, where nothing checks it.
 */
test("a reviewed work has already stopped claiming, before any URL is recorded", () => {
  const root = nodeProject({ name: "claim-released" });
  ok(root, ["init"]);
  ok(root, ["open", "w1", "--session", "s1"]);
  writeFile(join(root, ".kiln", "work", "w1", "plan.md"), "# plan\n");
  ok(root, ["gate", "w1", "plan", "--artifact", ".kiln/work/w1/plan.md", "--answer", "1. Approve this plan as written (recommended)", "--predicted", "src/app.js"]);

  ok(root, ["open", "w2", "--session", "s2"]);
  writeFile(join(root, ".kiln", "work", "w2", "plan.md"), "# plan\n");
  const blocked = kiln(root, ["gate", "w2", "plan", "--artifact", ".kiln/work/w2/plan.md", "--answer", "1. Approve this plan as written (recommended)", "--predicted", "src/app.js"]);
  assert.equal(blocked.status, 2, "while w1 is in progress the claim is real");

  writeReview(root, "w1");
  ok(root, ["gate", "w1", "review", "--artifact", ".kiln/work/w1/review.md", "--answer", "1. Approve this review (recommended)"]);
  assert.equal(state(root, "w1").status, "reviewed");

  const allowed = kiln(root, ["gate", "w2", "plan", "--artifact", ".kiln/work/w2/plan.md", "--answer", "1. Approve this plan as written (recommended)", "--predicted", "src/app.js"]);
  assert.equal(allowed.status, 0, "no URL was recorded, and the claim is gone anyway");
});

/**
 * Measured on a real run: the agent staged the two source files and left the work's record
 * out, so the history D18 says lives in `git log -- .kiln/work/<id>/` was empty. The plan now
 * prints the exact path list, record included unless `work.committed` is false.
 */
test("the ship plan names the exact paths to stage, the work's record included", () => {
  const root = nodeProject({ name: "stage-list" });
  throughPlanGate(root, "w1");
  writeFile(join(root, "src", "app.js"), "export const a = 2;\n");
  assert.match(ok(root, ["ship", "w1"]).stdout, /stage: git add -- src\/app\.js \.kiln\/work\/w1$/m);

  const kept = nodeProject({ name: "stage-list-uncommitted" });
  ok(kept, ["config", "set", "work.committed=false"]);
  throughPlanGate(kept, "w1");
  writeFile(join(kept, "src", "app.js"), "export const a = 2;\n");
  assert.match(ok(kept, ["ship", "w1"]).stdout, /stage: git add -- src\/app\.js$/m, "work.committed: false keeps the record out of the pull request");
});
