import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { DnaError, hasStore, storeDir } from "./store.mjs";

/**
 * A copy of the store kept where a wiped working tree cannot reach it (D162). The store already
 * survives a crash, a lost network and a plan limit — every write is atomic and the ledger says
 * what was read — but until a round is committed it lives only in the working tree, where
 * `git clean`, a stash or a branch switch removes it. Cline's checkpoints answer the same risk
 * the same way: a commit the user's history never sees.
 *
 * Built from objects alone — `hash-object --no-filters`, `mktree`, `commit-tree` — so the user's
 * index, filters and fsmonitor are never involved; written with `update-ref` with hooks switched
 * off for that one call, so a `reference-transaction` hook neither sees nor blocks it; and kept
 * under `refs/kiln/`, one ref per worktree and project path (D207), because two kiln projects in one repository,
 * or two worktrees of it, must never restore each other's store (D169).
 */

const IDENTITY = { GIT_AUTHOR_NAME: "kiln", GIT_AUTHOR_EMAIL: "kiln@localhost", GIT_COMMITTER_NAME: "kiln", GIT_COMMITTER_EMAIL: "kiln@localhost" };
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

function git(root, { args, env, input }) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", input, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * D207: which worktree this is, for the ref's name. `refs/worktree/` kept two worktrees apart
 * (D169) and hid the refs from gc: measured on git 2.43, `git gc --prune=now` in one linked
 * worktree deleted the commit behind another worktree's `refs/worktree/` checkpoint. A shared
 * ref keyed by the worktree's own git directory keeps them apart and keeps them alive.
 */
export function worktreeKey(root) {
  const own = realpathSync(git(root, { args: ["rev-parse", "--absolute-git-dir"] }));
  const common = realpathSync(git(root, { args: ["rev-parse", "--path-format=absolute", "--git-common-dir"] }));
  return own === common ? "_main" : basename(own);
}

/** The store's path from the top of the repository: the tree's prefix, and the ref's name. */
function location(root) {
  const top = realpathSync(git(root, { args: ["rev-parse", "--show-toplevel"] }));
  const path = relative(top, realpathSync(root)).split(sep).filter(Boolean);
  const name = path.length > 0 ? path.map((part) => part.replace(/[^\w.-]/g, "_")).join("/") : "_root";
  return { prefix: [...path, ".kiln", "dna", "store"], ref: `refs/kiln/dna-checkpoint/${worktreeKey(root)}/${name}/tip`, legacy: `refs/worktree/kiln/dna-checkpoint/${name}` };
}

/** The checkpoint a release before D207 wrote is still this project's last one. */
function currentTip(root, { ref, legacy }) {
  return tipOf(root, ref) ?? tipOf(root, legacy);
}

function tipOf(root, ref) {
  try {
    return git(root, { args: ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`] }) || null;
  } catch {
    // No checkpoint yet is an answer, not a failure.
    return null;
  }
}

/** The store's files as a tree, wrapped in one tree per directory above it. */
function storeTree(root, prefix) {
  const dir = storeDir(root);
  const names = readdirSync(dir).filter((name) => statSync(join(dir, name)).isFile()).sort();
  const blobs = git(root, { args: ["hash-object", "-w", "--no-filters", "--stdin-paths"], input: names.map((name) => join(dir, name)).join("\n") }).split("\n");
  let tree = git(root, { args: ["mktree"], input: names.map((name, index) => `100644 blob ${blobs[index]}\t${name}`).join("\n") });
  // Innermost out: the store's tree goes inside a tree named for its own directory, and so on up.
  for (let depth = prefix.length - 1; depth >= 0; depth -= 1) tree = git(root, { args: ["mktree"], input: `040000 tree ${tree}\t${prefix[depth]}` });
  return tree;
}

/**
 * Commits the store as it is now, if it differs from this project's last checkpoint. Returns
 * `{ commit }` or `{ error }`: a checkpoint is protection, and its absence must never undo a
 * write that has already landed — but it is said, not swallowed.
 */
export function checkpoint(root) {
  try {
    const where = location(root);
    const parent = currentTip(root, where);
    const tree = storeTree(root, where.prefix);
    if (parent && git(root, { args: ["rev-parse", `${parent}^{tree}`] }) === tree) return { commit: parent };
    const commit = git(root, { args: ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "kiln dna checkpoint"], env: IDENTITY });
    git(root, { args: [...NO_HOOKS, "update-ref", where.ref, commit, tipOf(root, where.ref) ?? ""] });
    return { commit };
  } catch (error) {
    return { error: String(error.stderr ?? error.message).trim().split("\n").at(-1) };
  }
}

export function checkpointInfo(root) {
  try {
    const tip = currentTip(root, location(root));
    return tip ? { commit: tip, date: git(root, { args: ["log", "-1", "--format=%cI", tip] }) } : null;
  } catch {
    // Outside a repository there is no checkpoint to speak of.
    return null;
  }
}

/**
 * Writes this project's checkpoint back — only where there is no store, and only files that sit
 * exactly under the store's own path in the checkpoint.
 */
export function restoreCheckpoint(root) {
  if (hasStore(root)) throw new DnaError("the working tree already has a store; restore only fills a missing one, it never overwrites.");
  const where = location(root);
  const { prefix } = where;
  const tip = currentTip(root, where) ?? (() => { throw new DnaError("there is no checkpoint of this project's store to restore from."); })();
  const entries = git(root, { args: ["ls-tree", "--full-tree", "-r", "-z", tip] }).split("\0").filter(Boolean).map((line) => ({ blob: line.split(/\s+/)[2], path: line.slice(line.indexOf("\t") + 1) }));
  const base = `${prefix.join("/")}/`;
  const foreign = entries.filter((entry) => !entry.path.startsWith(base) || entry.path.slice(base.length).includes("/"));
  if (foreign.length > 0 || entries.length === 0) throw new DnaError(`checkpoint ${tip.slice(0, 12)} does not hold exactly this project's store; nothing was written.`);
  mkdirSync(storeDir(root), { recursive: true });
  for (const entry of entries) writeFileSync(join(storeDir(root), entry.path.slice(base.length)), execFileSync("git", ["cat-file", "blob", entry.blob], { cwd: root }));
  return tip;
}
