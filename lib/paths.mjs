import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

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

/**
 * Returns the nearest ancestor that exists, plus the segments climbed to reach it.
 * Dropping that tail collapses `app/migrations/001.php` to `001.php` whenever the
 * directories are not there yet — which is every new file — and any guard that reads
 * the shape of a path then reads the wrong shape.
 */
function existingPrefix(path) {
  const climbed = [];
  let dir = path;
  for (;;) {
    try {
      return { real: realpathSync(dir), climbed };
    } catch {
      const parent = dirname(dir);
      if (parent === dir) throw new PathError(`no existing ancestor for ${path}`);
      climbed.unshift(basename(dir));
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
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  if (isSymlink(absolute)) throw new PathError(`refusing to follow a symlink: ${absolute}`);
  const { real, climbed } = existingPrefix(dirname(absolute));
  return join(real, ...climbed, basename(absolute));
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
