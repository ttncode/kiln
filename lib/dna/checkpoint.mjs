import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DnaError, hasStore } from "./store.mjs";

/**
 * A copy of the store kept where a wiped working tree cannot reach it (D162). The store already
 * survives a crash, a lost network and a plan limit — every write is atomic and the ledger says
 * what was read — but until a round is committed it lives only in the working tree, where
 * `git clean`, a stash or a branch switch removes it. Cline's checkpoints answer the same risk
 * the same way: a commit the user's history never sees. Here it is a commit on
 * `refs/kiln/dna-checkpoint`, built through a temporary index, so HEAD, the user's index, their
 * hooks and their branches are never touched, and nothing is pushed.
 */

export const CHECKPOINT_REF = "refs/kiln/dna-checkpoint";
const STORE_PATH = ".kiln/dna/store";
const IDENTITY = { GIT_AUTHOR_NAME: "kiln", GIT_AUTHOR_EMAIL: "kiln@localhost", GIT_COMMITTER_NAME: "kiln", GIT_COMMITTER_EMAIL: "kiln@localhost" };

function git(root, { args, env }) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tipOf(root) {
  try {
    return git(root, { args: ["rev-parse", "--verify", "--quiet", `${CHECKPOINT_REF}^{commit}`] }) || null;
  } catch {
    // No checkpoint yet is an answer, not a failure.
    return null;
  }
}

function withIndex(work) {
  const dir = mkdtempSync(join(tmpdir(), "kiln-dna-index-"));
  try {
    return work({ GIT_INDEX_FILE: join(dir, "index") });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Commits the store as it is now, if it differs from the last checkpoint. Returns the commit,
 * the unchanged tip, or null outside a git repository — a checkpoint is protection, and its
 * absence must never stop a write that has already landed.
 */
export function checkpoint(root) {
  try {
    const parent = tipOf(root);
    const tree = withIndex((env) => {
      git(root, { args: ["read-tree", "--empty"], env });
      git(root, { args: ["add", "--force", "--", STORE_PATH], env });
      return git(root, { args: ["write-tree"], env });
    });
    if (parent && git(root, { args: ["rev-parse", `${parent}^{tree}`] }) === tree) return parent;
    const commit = git(root, { args: ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "kiln dna checkpoint"], env: IDENTITY });
    git(root, { args: ["update-ref", CHECKPOINT_REF, commit, parent ?? ""] });
    return commit;
  } catch {
    // Not a repository, or git refused: the store on disk is intact either way.
    return null;
  }
}

export function checkpointInfo(root) {
  const tip = tipOf(root);
  return tip ? { commit: tip, date: git(root, { args: ["log", "-1", "--format=%cI", tip] }) } : null;
}

/** Writes the checkpoint's store back into the working tree — only where there is no store. */
export function restoreCheckpoint(root) {
  if (hasStore(root)) throw new DnaError("the working tree already has a store; restore only fills a missing one, it never overwrites.");
  const tip = tipOf(root);
  if (!tip) throw new DnaError(`there is no checkpoint (${CHECKPOINT_REF}) to restore from.`);
  withIndex((env) => {
    git(root, { args: ["read-tree", tip], env });
    git(root, { args: ["checkout-index", "--all", "--force"], env });
  });
  return tip;
}
