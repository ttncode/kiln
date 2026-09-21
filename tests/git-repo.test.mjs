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

  assert.deepEqual(branchesFor("git push", context), ["main"], "the superproject");
  assert.deepEqual(branchesFor("git -C AdminPage push", context), ["v3-master"], "the submodule");

  const repoFor = (part) => ({ branches: branchesFor(part, context), resolveRef: () => null });
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

  const branches = branchesFor("cd $WHEREVER && git push", { root, cwd: root });
  assert.deepEqual(branches.sort(), ["main", "v3-master"], "blocking too much beats blocking the wrong thing");
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

  assert.deepEqual(branches("cd AdminPage && git push", 1), ["v3-master"]);
  assert.deepEqual(branches("cd AdminPage || git push", 1).sort(), ["main", "v3-master"]);
});
