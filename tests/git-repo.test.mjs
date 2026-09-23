import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { branchesFor, checkoutsUnder, cwdChain, dirOf, repoAt, workdirOf } from "../lib/guards/git-repo.mjs";
import { protectedBranchViolation } from "../lib/guards/protected-branch.mjs";
import { cleanupFixtures, commitAll, git, initRepo, tempRoot, writeFile } from "./helpers/fixture.mjs";

after(cleanupFixtures);

/**
 * A superproject whose submodule sits on a different branch — the shape that made one
 * command get two answers depending on a directory the guard never looked at.
 */
function superproject() {
  const sub = initRepo(tempRoot("kiln-repo-sub-"));
  git(sub, ["checkout", "-q", "-b", "v3-master"]);
  writeFile(join(sub, "a.txt"), "a");
  commitAll(sub, "sub");

  const root = initRepo(tempRoot("kiln-repo-super-"));
  writeFile(join(root, "README.md"), "super");
  commitAll(root, "super");
  git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "AdminPage"]);
  commitAll(root, "add submodule");
  return root;
}

test("the directory a git command runs in is read from the command", () => {
  assert.deepEqual(workdirOf("git -C AdminPage push"), { dir: "AdminPage", known: true });
  assert.deepEqual(workdirOf("cd AdminPage && git push"), { dir: "AdminPage", known: true });
  assert.deepEqual(workdirOf("git push"), { dir: null, known: true });
  assert.equal(workdirOf("cd $TARGET && git push").known, false, "a variable is not a directory");
  assert.equal(workdirOf("cd - && git push").known, false, "neither is the last one");
});

test("git says which repository owns a directory, including a nested one", () => {
  const root = superproject();
  assert.equal(repoAt(root), root);
  assert.equal(repoAt(join(root, "AdminPage")), join(root, "AdminPage"));
});

test("a push inside a submodule is judged against the submodule's branch", () => {
  const root = superproject();
  const context = { root, cwd: root };

  assert.deepEqual(branchesFor("git push", context).branches, ["main"], "the superproject");
  assert.deepEqual(branchesFor("git -C AdminPage push", context).branches, ["v3-master"], "the submodule");

  const repoFor = (part) => ({ ...branchesFor(part, context), resolveRef: () => null });
  const hit = protectedBranchViolation({ command: "git -C AdminPage push", protectedBranches: ["v3-master"], repoFor });
  assert.equal(hit?.branch, "v3-master", "the superproject is on main, which is not protected here");

  assert.equal(
    protectedBranchViolation({ command: "git push", protectedBranches: ["v3-master"], repoFor }),
    null,
    "and the superproject's own push is not judged against the submodule",
  );
});

test("an unreadable directory falls back to every checkout here, not to a guess", () => {
  const root = superproject();
  assert.deepEqual(checkoutsUnder(root).sort(), [root, join(root, "AdminPage")].sort());

  const found = branchesFor("cd $WHEREVER && git push", { root, cwd: root });
  assert.deepEqual(found.branches.sort(), ["main", "v3-master"], "blocking too much beats blocking the wrong thing");
  assert.equal(found.resolved, false, "and the caller is told this is a candidate set, not the branch");
});

test("dirOf resolves relative to the session's directory", () => {
  assert.equal(dirOf("git -C sub push", "/tmp/x"), "/tmp/x/sub");
  assert.equal(dirOf("git -C /abs push", "/tmp/x"), "/abs");
  assert.equal(dirOf("git push", "/tmp/x"), "/tmp/x");
});

/**
 * `cd AdminPage && git push` puts the push in AdminPage, but the two halves are separate
 * segments and the second carries no directory. Judged without the chain, the push was
 * checked against the superproject and blocked for a branch it would never touch.
 */
test("a cd carries the directory forward only where the shell would", () => {
  assert.deepEqual(cwdChain("git push", "/r"), ["/r"]);
  assert.deepEqual(cwdChain("cd sub && git push", "/r"), ["/r", "/r/sub"]);
  assert.deepEqual(cwdChain("cd sub; git push", "/r"), ["/r", "/r/sub"]);
  assert.deepEqual(cwdChain("cd a && cd ../b && git push", "/r"), ["/r", "/r/a", "/r/b"]);

  assert.deepEqual(cwdChain("cd sub || git push", "/r"), ["/r", null], "|| runs when the cd failed");
  assert.deepEqual(cwdChain("cd $X && git push", "/r"), ["/r", null], "a variable is not a directory");
  assert.deepEqual(cwdChain("git status || git push", "/r"), ["/r", "/r"], "no cd, nothing uncertain");
});

test("an uncertain directory is judged against every checkout, and a certain one is not", () => {
  const root = superproject();
  const chain = (command) => cwdChain(command, root);
  const branches = (command, index) => branchesFor(command.split(/&&|\|\||;/)[index].trim(), { root, cwd: chain(command)[index] });

  assert.deepEqual(branches("cd AdminPage && git push", 1).branches, ["v3-master"]);
  assert.deepEqual(branches("cd AdminPage || git push", 1).branches.sort(), ["main", "v3-master"]);
});

/**
 * Measured on a real monorepo. A module standing on `feature/v3/#1864` ran
 *
 *   git merge origin/v3-master
 *
 * and kiln refused it as a write to `v3-master` — which was the merge's **source**. The
 * superproject was on `v3-master`, the directory was not readable from the command text, and
 * the fallback judged a one-branch write against every checkout's branch.
 *
 * "Every checkout" is a sound over-approximation for a push, whose refspec can name any ref
 * on the remote. It is not one for `merge`, `commit`, `rebase`, `reset`, `revert` or
 * `cherry-pick`: each writes to exactly one branch, the one HEAD is on where the command
 * runs, and a set containing other repositories' branches is a different set, not a wider one.
 *
 * The user worked around it by merging the commit SHA instead. That is what a false block
 * always buys, and it is the reason this is a defect rather than an inconvenience.
 */
test("a merge is judged against the branch it writes to, never against every checkout", () => {
  const root = superproject();
  const chain = (command) => cwdChain(command, root);
  const repoFor = (command) => (part, index) => ({ ...branchesFor(part, { root, cwd: chain(command)[index] }), resolveRef: () => null });
  const verdict = (command) => protectedBranchViolation({ command, protectedBranches: ["v3-master"], repoFor: repoFor(command) });

  const unreadable = "cd $MODULE && git merge origin/v3-master";
  assert.equal(verdict(unreadable), null, "v3-master is the source; the branch being written to is unknown and is not every branch");

  for (const op of ["commit -m x", "rebase origin/v3-master", "reset --hard HEAD~1", "revert HEAD", "cherry-pick abc123"]) {
    assert.equal(verdict(`cd $MODULE && git ${op}`), null, `git ${op} writes to one branch`);
  }
});

/**
 * The half that must not move. A push names its own destination, so an unreadable directory
 * still means every checkout is a candidate — and D7 item 1 is the promise made of that half.
 */
test("a push with an unreadable directory is still judged against every checkout", () => {
  const root = superproject();
  const chain = (command) => cwdChain(command, root);
  const repoFor = (command) => (part, index) => ({ ...branchesFor(part, { root, cwd: chain(command)[index] }), resolveRef: () => null });

  const command = "cd $MODULE && git push";
  const hit = protectedBranchViolation({ command, protectedBranches: ["v3-master"], repoFor: repoFor(command) });
  assert.equal(hit?.branch, "v3-master");
});

/** And a HEAD-writing op kiln *can* place is judged exactly as before. */
test("a merge kiln can place is still blocked when it writes to a protected branch", () => {
  const root = superproject();
  const repoFor = (part) => ({ ...branchesFor(part, { root, cwd: root }), resolveRef: () => null });

  const hit = protectedBranchViolation({ command: "git -C AdminPage merge origin/topic", protectedBranches: ["v3-master"], repoFor });
  assert.equal(hit?.branch, "v3-master", "AdminPage is on v3-master, and the merge lands there");
  assert.equal(hit?.subcommand, "merge");
});
