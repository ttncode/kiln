import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { gitOutput } from "./init.mjs";

const SKIP = new Set(["node_modules", ".git", "dist", "build", "vendor", "coverage", ".next"]);
const MAX_BYTES = 512 * 1024;
const TEXT = /\.(m?[jt]sx?|php|py|rb|go|java|kt|cs|rs|sql|json|ya?ml|md|html|css|scss)$/i;

function walk(dir, root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name) || entry.name === ".kiln") return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path, root);
    return TEXT.test(entry.name) && statSync(path).size <= MAX_BYTES ? [relative(root, path)] : [];
  });
}

function escapeTerm(term) {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Knowledge tier 0. A real grep, never a no-op (D47): the port has to be genuinely
 * exercised at v1 or the question of whether it should exist cannot be answered by
 * anything but argument.
 */
export function grepBlastRadius(root, terms) {
  const patterns = terms.filter(Boolean).map((term) => new RegExp(escapeTerm(term), "i"));
  if (patterns.length === 0) return [];

  return walk(root, root)
    .map((path) => ({ path, hits: countHits(join(root, path), patterns) }))
    .filter((row) => row.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.path.localeCompare(b.path));
}

function countHits(absolute, patterns) {
  try {
    const text = readFileSync(absolute, "utf8");
    return patterns.filter((pattern) => pattern.test(text)).length;
  } catch {
    return 0;
  }
}

/**
 * The status field is one or two characters wide and may lose its leading space to a
 * trim, so a fixed slice is off by one on exactly the modified-tracked-file case — and
 * it produces a path that looks almost right (`rc/a.ts`), which reconciliation would
 * then report as beyond prediction forever.
 */
export function statusPathOf(line) {
  const path = line.replace(/^.{0,2}\s+/, "");
  return path.includes(" -> ") ? path.split(" -> ").pop() : path;
}

function isSubmodule(root, path) {
  return existsSync(join(root, path, ".git"));
}

/**
 * A submodule is one line in its superproject's status — ` M AdminPage` — no matter how
 * many files changed inside it. On the monorepo kiln was first run against, every file
 * the work touched lived in a submodule, so reconciliation reported `actual 0` and then
 * said "nothing changed in this range", which was a confident false statement about a
 * tree with edits in it. Submodules are the layout D45 refuses a worktree for; they
 * cannot also be the layout reconciliation is blind to.
 */
export function statusPaths(root) {
  const output = gitOutput(root, ["status", "--short"]) ?? "";
  return output
    .split("\n")
    .filter(Boolean)
    .map(statusPathOf)
    .flatMap((path) => (isSubmodule(root, path) ? insideSubmodule(root, path) : [path]));
}

/**
 * The third shape, and the one every run on a submodule project ends in: the change is
 * **committed inside the submodule** and the superproject has not recorded the new gitlink
 * yet. The submodule's own status is then clean, and the superproject's status is the one
 * line ` M AdminPage` — so neither half above sees a file. Measured on a real monorepo: a
 * work whose only commit landed in `AdminPage` reported `beyond: AdminPage`, and
 * `kiln rules --stage review` matched the gitlink instead of the controller, so "controllers
 * must not contain SQL" was never routed to the review that existed to check it.
 *
 * The superproject's index holds the SHA it still believes in, so git answers this outright.
 */
function committedAhead(root, path) {
  const recorded = gitOutput(root, ["rev-parse", `:${path}`]);
  if (!recorded) return [];
  const names = gitOutput(join(root, path), ["diff", "--name-only", `${recorded}..HEAD`]);
  return (names ?? "").split("\n").filter(Boolean).map((name) => `${path}/${name}`);
}

function insideSubmodule(root, path) {
  const inner = gitOutput(join(root, path), ["status", "--short"]) ?? "";
  const changed = inner.split("\n").filter(Boolean).map((line) => `${path}/${statusPathOf(line)}`);
  const named = [...new Set([...changed, ...committedAhead(root, path)])];
  return named.length > 0 ? named : [path];
}

/**
 * The committed half of the same blindness: at the superproject level a submodule's
 * commits are one gitlink whose old and new SHAs `--raw` prints, so the file names are
 * one diff further down.
 */
function committedInSubmodules(root, range) {
  const raw = (gitOutput(root, ["diff", "--raw", "--abbrev=40", range]) ?? "").split("\n").filter(Boolean);
  return raw.flatMap((line) => {
    const [meta, path] = line.split("\t");
    const [, mode, before, after] = meta.split(" ");
    if (mode !== "160000" || /^0+$/.test(before) || !isSubmodule(root, path)) return [];
    const names = gitOutput(join(root, path), ["diff", "--name-only", `${before}..${after}`]) ?? "";
    return names.split("\n").filter(Boolean).map((name) => `${path}/${name}`);
  });
}

/** kiln's own artifacts are not the change under review; predicted[] holds source. */
function isSource(path) {
  return path !== "" && !path.startsWith(".kiln/") && path !== ".kiln";
}

/**
 * Three dots is merge-base semantics, which is what keeps a moved integration branch
 * from showing its newer files as phantom deletions (superpowers #2133).
 */
export function actualChanged(root, from) {
  const range = `${from}...HEAD`;
  const committed = (gitOutput(root, ["diff", "--name-only", range]) ?? "").split("\n").filter(Boolean);
  const nested = committedInSubmodules(root, range);
  const paths = [...committed.filter((path) => !isSubmodule(root, path)), ...nested, ...statusPaths(root)];
  return [...new Set(paths)].filter(isSource).sort();
}

/**
 * `actualChanged` diffs `base...HEAD`, which is merge-base to HEAD — correct git, and
 * meaningless when the branch was cut from somewhere the recorded base does not reach.
 * Measured: a work opened on v3-master, whose branch was then cut from another ticket's
 * branch, reported `predicted 11 · actual 283`. The real diff was the 11 predicted files.
 * The agent worked out why; nobody else reading `283` would have.
 *
 * git answers this directly, so nothing is inferred from the count.
 */
export function anchorVerdict(root, base) {
  if (!base) return { ok: true };
  if (gitOutput(root, ["cat-file", "-e", `${base}^{commit}`]) === null) {
    return { ok: false, reason: "is not a commit in this checkout" };
  }
  return gitOutput(root, ["merge-base", "--is-ancestor", base, "HEAD"]) === null
    ? { ok: false, reason: "is not an ancestor of HEAD, so this branch did not grow from it" }
    : { ok: true };
}

export function offBranchMessage(id, { base, reason }) {
  return `This work was opened at ${String(base).slice(0, 9)}, which ${reason}.
Every count here would be measured from where the two histories last met, which is somebody else's work as well as yours.
Re-anchor it to where this branch actually started: \`kiln open ${id} --base <commit-ish>\``;
}

export function pathsOf(predicted) {
  return (predicted ?? []).map((row) => (typeof row === "string" ? row : row.path)).filter(Boolean);
}

/**
 * Work already uncommitted when the run opened is not this run's doing. `git status`
 * has no notion of "since", so the set is recorded at open and subtracted here —
 * otherwise a half-finished file the user left lying around is reported as beyond
 * prediction on every run, and a line that cries wolf is a line people stop reading.
 */
export function reconcile({ predicted, actual, dirtyAtOpen = [] }) {
  const claimed = new Set(pathsOf(predicted));
  const preexisting = new Set(dirtyAtOpen);
  const touched = new Set(actual.filter((path) => !preexisting.has(path) || claimed.has(path)));
  return {
    predicted: claimed.size,
    actual: touched.size,
    beyond: [...touched].filter((path) => !claimed.has(path)),
    notTouched: [...claimed].filter((path) => !touched.has(path)),
  };
}

/** Statistics reach the conversation; the diff body stays a file read on demand (D67b). */
export function reconciliationLine(result) {
  const parts = [`Scope — predicted ${result.predicted} · actual ${result.actual}`];
  if (result.beyond.length > 0) parts.push(`⚠ ${result.beyond.length} beyond prediction`);
  if (result.notTouched.length > 0) parts.push(`${result.notTouched.length} predicted-not-touched`);
  return parts.join(" · ");
}

/**
 * Reports and never blocks (D31) — discovery during implementation is legitimate — with
 * one exception. A diff of zero files is not divergence, it is the absence of the thing
 * under review, and its common cause is an implementer who committed to another branch
 * (D56, upstream #2136).
 */
export function reconcileVerdict(result) {
  if (result.actual === 0) {
    return { halt: true, reason: "nothing changed in this range. The usual cause is a commit on another branch." };
  }
  return { halt: false };
}

/**
 * The copy keeps the original's mtime, because git's racy-clean check depends on it: a file
 * modified after the index was written is re-read rather than trusted by its stat. A copy
 * stamped *now* is newer than every edit, so an edit that kept the file's size — `a = 1`
 * to `a = 2` — was trusted as unchanged and the tree came back identical.
 */
function copyIndex(from, to) {
  copyFileSync(from, to);
  const { atime, mtime } = statSync(from);
  utimesSync(to, atime, mtime);
}

/**
 * The tree the working directory holds right now, as git would name it — tracked changes,
 * untracked files, and nothing under `.kiln/`, whose state file changes every time a step
 * runs. A copy of the real index is updated rather than built from empty, so git rehashes
 * only what changed. This is what makes evidence comparable to a tree nobody has committed:
 * kiln commits only at SHIP, so a range of commits cannot see the edits made after a run.
 */
export function worktreeTree(root) {
  const scratch = mkdtempSync(join(tmpdir(), "kiln-tree-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
    const index = gitOutput(root, ["rev-parse", "--git-path", "index"]);
    const real = index && (isAbsolute(index) ? index : join(root, index));
    if (real && existsSync(real)) copyIndex(real, env.GIT_INDEX_FILE);
    const git = (args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    git(["add", "-A", "--", ".", ":(exclude).kiln"]);
    // An exclude pathspec stops `.kiln/` being updated, not being there: once SHIP commits
    // the work's record, the index carries it, and every later tree would differ by it.
    git(["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ".kiln"]);
    return git(["write-tree"]);
  } catch {
    // A tree kiln could not measure is recorded as none, and a record naming no tree is
    // stale by definition — so this can only make evidence weaker, never stronger.
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
