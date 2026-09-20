import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

/**
 * macOS and Windows ship case-insensitive filesystems by default, so `.KILN/config.json`
 * is the same file as `.kiln/config.json` but not the same string — and a deny list
 * compared exactly would miss it. Linux compares exactly, because there the two are
 * genuinely different files.
 */
const FOLD_CASE = process.platform === "darwin" || process.platform === "win32";

export class PathError extends Error {}

function fold(segment) {
  return FOLD_CASE ? segment.toLowerCase() : segment;
}

export function segments(path) {
  return path.split(sep).filter(Boolean).map(fold);
}

/** A string prefix is not a boundary: `/home/you/repo-evil` starts with `/home/you/repo`. */
export function isInside(root, target) {
  const rootParts = segments(root);
  const targetParts = segments(target);
  if (targetParts.length < rootParts.length) return false;
  return rootParts.every((part, index) => part === targetParts[index]);
}

export function pathEquals(left, right) {
  const a = segments(left);
  const b = segments(right);
  return a.length === b.length && a.every((part, index) => part === b[index]);
}

function nearestExisting(path) {
  let dir = path;
  for (;;) {
    try {
      return realpathSync(dir);
    } catch {
      const parent = dirname(dir);
      if (parent === dir) throw new PathError(`no existing ancestor for ${path}`);
      dir = parent;
    }
  }
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The leaf may not exist yet — a guard runs before the write — so the parent is what
 * gets resolved. A symlink leaf is rejected outright rather than followed: following it
 * is the arbitrary-file-overwrite primitive agent-skills #295 rates High.
 */
export function resolveTarget(path, cwd) {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  if (isSymlink(absolute)) throw new PathError(`refusing to follow a symlink: ${absolute}`);
  const parent = nearestExisting(dirname(absolute));
  return resolve(parent, absolute.slice(dirname(absolute).length + 1) || ".");
}

/**
 * Answers the sandbox question without throwing, because a guard that throws on a
 * malformed path has to decide what that means; here, unresolvable is outside.
 */
export function targetIsInside(root, { path, cwd }) {
  try {
    return isInside(realpathSync(root), resolveTarget(path, cwd));
  } catch {
    return false;
  }
}
