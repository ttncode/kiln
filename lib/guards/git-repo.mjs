import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { gitOutput } from "../init.mjs";

/**
 * A guard that holds one branch name is right about one repository. On a superproject
 * with submodules there is no such thing as "the" branch: measured on a real checkout,
 * `git -C AdminPage push` was judged against the superproject's `main` while the push
 * went to AdminPage's `v3-master`. Same command, two answers, and which one you get
 * depends on a directory the guard never looked at.
 *
 * So the directory is read from the command, and git — not a pattern — says which
 * repository owns it.
 */
const UNSTABLE = /[$`*?~]|^-$/;

function tokenize(part) {
  return part.split(/\s+/).filter(Boolean);
}

/** `git -C <dir>` and a leading `cd <dir> &&` are the two spellings that stay readable. */
export function workdirOf(part) {
  const tokens = tokenize(part);
  const dashC = tokens.indexOf("-C");
  if (dashC !== -1 && tokens[dashC + 1]) return dirOrUnknown(tokens[dashC + 1]);
  if (tokens[0] === "cd" && tokens[1]) return dirOrUnknown(tokens[1]);
  return { dir: null, known: true };
}

/**
 * `cd AdminPage && git push` means the push happens in AdminPage, but the two halves are
 * separate segments and the second one carries no directory. Judged without this, the
 * push was checked against the superproject and blocked for a branch it was never going
 * to touch — a false block, and false blocks are what teach an agent to route around.
 *
 * Only `&&` and `;` carry the directory forward. `||` runs its right side when the left
 * one *failed*, so a `cd` before it may not have happened; that yields unknown, and
 * unknown means every checkout here. This is not shell parsing creeping back in — it is
 * three operators, and anything outside them is answered "I cannot tell".
 */
export function cwdChain(command, cwd) {
  let current = cwd;
  let moved = false;
  return splitWithOperators(command).map(({ part, sequential }) => {
    if (moved && !sequential) current = null;
    const here = current;
    if (tokenize(part)[0] !== "cd") return here;
    moved = true;
    const { dir, known } = workdirOf(part);
    current = here !== null && known && dir ? (isAbsolute(dir) ? dir : resolve(here, dir)) : null;
    return here;
  });
}

function splitWithOperators(command) {
  const pieces = command.split(/(&&|\|\||;|\n)/);
  const parts = [];
  for (let index = 0; index < pieces.length; index += 2) {
    const part = pieces[index].trim();
    if (part) parts.push({ part, sequential: index === 0 || pieces[index - 1] !== "||" });
  }
  return parts;
}

function dirOrUnknown(token) {
  const dir = token.replace(/^["']|["']$/g, "");
  return UNSTABLE.test(dir) ? { dir: null, known: false } : { dir, known: true };
}

export function repoAt(dir) {
  return gitOutput(dir, ["rev-parse", "--show-toplevel"]);
}

export function branchAt(dir) {
  return gitOutput(dir, ["symbolic-ref", "--short", "HEAD"]);
}

/**
 * The fallback when the directory is not readable from the text. Candidates come from
 * `.gitmodules`, which is git's own record of what else is checked out here — one file
 * read, no tree walk on a guard's hot path.
 */
export function checkoutsUnder(root) {
  const file = join(root, ".gitmodules");
  if (!existsSync(file)) return [root];
  const paths = [...readFileSync(file, "utf8").matchAll(/^\s*path\s*=\s*(.+)$/gm)].map((match) => match[1].trim());
  return [root, ...paths.map((path) => join(root, path))].filter((dir) => existsSync(dir));
}

/**
 * Resolving to a set, not a name: when the directory is unknown, every checkout here is
 * a candidate and the command is judged against all of them. Blocking more than one
 * repository needs is the direction D33 chooses when it cannot tell.
 */
/** Plain path resolution, not `resolveTarget`: this names a directory to ask git about, not a file to write. */
export function dirOf(part, cwd) {
  const { dir } = workdirOf(part);
  if (!dir) return cwd;
  return isAbsolute(dir) ? dir : resolve(cwd, dir);
}

/**
 * `resolved` says which of the two answers this is, because they are not the same kind of
 * fact and the caller must not treat them alike. One branch, read from the directory the
 * command will run in, is *the* branch. Every checkout's branch is *the candidates*, and a
 * candidate set is only a safe over-approximation for an operation that could write to any
 * member of it.
 */
export function branchesFor(part, { root, cwd }) {
  if (cwd === null || !workdirOf(part).known) {
    return { branches: checkoutsUnder(root).map(branchAt).filter(Boolean), resolved: false };
  }
  const branch = branchAt(dirOf(part, cwd));
  return { branches: branch ? [branch] : [], resolved: true };
}

/**
 * Every file git tracks anywhere under the root, named the way a stage names it.
 *
 * `git ls-files` at a superproject lists a submodule as **one gitlink entry** — `AdminPage`,
 * not its 71 controllers. Measured on a real monorepo: a rule routed to
 * `**\/application/controllers/**` was reported by doctor as matching no file here, and the
 * rule fires perfectly well, because `kiln rules` matches the paths a stage names and those
 * come from `actualChanged`, which walks the submodules.
 *
 * So the dead-route check was blind to exactly the code kiln was installed to guard, and on
 * that project the warning would have stood for every rule anyone wrote. A warning that is
 * always wrong is a warning people stop reading — D89's own finding, one instrument over.
 *
 * Third time the answer is the same: ask every checkout, not the one you are standing in.
 */
export function trackedUnder(root) {
  return checkoutsUnder(root).flatMap((dir) => {
    const listed = gitOutput(dir, ["ls-files"]);
    if (listed === null) return [];
    const prefix = relative(root, dir);
    return listed.split("\n").filter(Boolean).map((path) => (prefix ? `${prefix}/${path}` : path));
  });
}
