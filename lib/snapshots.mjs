import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { checkoutTrees } from "./blast.mjs";
import { worktreeKey } from "./dna/checkpoint.mjs";
import { claimOwner } from "./guards/context.mjs";

/**
 * D208: a snapshot of the working tree per task, and the way back to one. agent-skills' save
 * point is a commit per passing change (git-workflow-and-versioning, 2686b62); kiln commits once,
 * at SHIP (D142, D206), and refuses the reverts (D205). So a snapshot is a commit object no
 * branch points at: `checkoutTree`'s tree (`.kiln/` and ignored files left out), written with
 * hooks off under a shared `refs/kiln/` ref every worktree's gc can see (D207).
 */

const IDENTITY = { GIT_AUTHOR_NAME: "kiln", GIT_AUTHOR_EMAIL: "kiln@localhost", GIT_COMMITTER_NAME: "kiln", GIT_COMMITTER_EMAIL: "kiln@localhost" };
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];
const GITLINK = "160000";

function git(dir, { args, env, input }) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", input, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Two kiln projects in one repository keep their snapshots apart, as their checkpoints are. */
function projectKey(root) {
  const top = realpathSync(git(root, { args: ["rev-parse", "--show-toplevel"] }));
  const path = relative(top, realpathSync(root)).split(sep).filter(Boolean);
  return path.length > 0 ? path.map((part) => part.replace(/[^\w.-]/g, "_")).join("/") : "_root";
}

function refPrefix(root, { dir, id }) {
  return `refs/kiln/snapshot/${worktreeKey(dir)}/${projectKey(root)}/${id}/`;
}

function commitRow(root, { state, name, row }) {
  const dir = join(root, row.dir);
  const parent = state.snapshots?.at(-1)?.commits?.[row.dir];
  const commit = git(dir, { args: ["commit-tree", row.tree, ...(parent ? ["-p", parent] : []), "-m", `kiln snapshot ${state.id} ${name}`], env: IDENTITY });
  git(dir, { args: [...NO_HOOKS, "update-ref", `${refPrefix(root, { dir, id: state.id })}${name}`, commit] });
  return [row.dir, commit];
}

/**
 * `{ entry }` — `{ name, commits: { <checkout>: <sha> } }` — or `{ error }`. A snapshot is
 * protection, so failing to take one never fails the call that asked; it is said instead.
 */
export function takeSnapshot(root, { state, name, trees = checkoutTrees(root) }) {
  if (trees.some((row) => row.tree === null)) return { error: "a checkout's tree could not be built" };
  try {
    return { entry: { name, commits: Object.fromEntries(trees.map((row) => commitRow(root, { state, name, row }))) } };
  } catch (error) {
    return { error: String(error.stderr ?? error.message).trim().split("\n").at(-1) };
  }
}

/** Drops every snapshot ref of the work; the commits go with git's own gc. */
export function dropSnapshots(root, state) {
  for (const dir of Object.keys(state.snapshots?.at(-1)?.commits ?? {})) {
    const at = join(root, dir);
    try {
      const refs = git(at, { args: ["for-each-ref", "--format=%(refname)", refPrefix(root, { dir: at, id: state.id })] }).split("\n").filter(Boolean);
      for (const ref of refs) git(at, { args: [...NO_HOOKS, "update-ref", "-d", ref] });
    } catch {
      // ponytail: a checkout that is gone has no refs left to drop.
    }
  }
}

/** `{ status, path }` rows of what differs between two trees, gitlinks apart. */
function changedPaths(dir, { from, to }) {
  const raw = git(dir, { args: ["diff-tree", "-r", "--no-renames", "-z", from, to] }).split("\0").filter(Boolean);
  const rows = [];
  for (let at = 0; at < raw.length; at += 2) {
    const [oldMode, newMode, , , status] = raw[at].slice(1).split(" ");
    rows.push({ status, path: raw[at + 1], gitlink: oldMode === GITLINK || newMode === GITLINK });
  }
  return rows;
}

function restorable(root, { state, row, prefix }) {
  const path = `${prefix}${row.path}`;
  if (row.gitlink || path.startsWith(".kiln/")) return false;
  if ((state.dirty_at_open ?? []).includes(path)) return false;
  return claimOwner(root, { path, excludeId: state.id }) === null;
}

/** Writes paths back from `tree` the way git checks them out: filters, line endings, modes, links. */
function checkoutPaths(dir, { tree, paths }) {
  if (paths.length === 0) return;
  const scratch = mkdtempSync(join(tmpdir(), "kiln-restore-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    git(dir, { args: ["read-tree", tree], env });
    git(dir, { args: ["checkout-index", "-f", "--stdin", "-z"], env, input: `${paths.join("\0")}\0` });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** One checkout back to `commit`'s tree, for the paths this work may touch. */
function restoreCheckout(root, { state, dir, commit, current }) {
  const at = join(root, dir);
  const prefix = dir === "." ? "" : `${dir}/`;
  const rows = changedPaths(at, { from: `${commit}^{tree}`, to: current });
  const kept = rows.filter((row) => restorable(root, { state, row, prefix }));
  for (const row of kept.filter((entry) => entry.status === "A")) rmSync(join(at, row.path), { force: true });
  checkoutPaths(at, { tree: `${commit}^{tree}`, paths: kept.filter((entry) => entry.status !== "A").map((entry) => entry.path) });
  return {
    written: kept.map((row) => `${prefix}${row.path}`),
    skipped: rows.filter((row) => !kept.includes(row)).map((row) => `${prefix}${row.path}${row.gitlink ? " (a submodule's commit)" : ""}`),
  };
}

/** Every checkout of `entry` back to its snapshot, given the trees as they are now. */
export function restoreSnapshot(root, { state, entry, trees }) {
  const current = Object.fromEntries(trees.map((row) => [row.dir, row.tree]));
  const results = Object.entries(entry.commits).map(([dir, commit]) => restoreCheckout(root, { state, dir, commit, current: current[dir] }));
  return { written: results.flatMap((row) => row.written), skipped: results.flatMap((row) => row.skipped) };
}
