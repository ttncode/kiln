import { join, sep } from "node:path";
import { isInside, pathEquals } from "./../paths.mjs";

const CONTROL_FILES = ["config.json", "state.json"];

function kilnDir(root) {
  return join(root, ".kiln");
}

function basename(path) {
  return path.split(sep).pop();
}

/**
 * D48: the enforcement must not read a file the enforced party can write. One Edit
 * setting a gate to approved would unlock source edits, and the same shape empties
 * vcs.protected. This holds whether or not kiln is driving the session, because an
 * emptied protected list outlives the run that emptied it.
 */
export function isControlFile(root, target) {
  return isInside(kilnDir(root), target) && CONTROL_FILES.includes(basename(target));
}

/**
 * `.kiln/work/` is kiln's own state area, so a path inside it belongs to whichever work
 * owns that directory — and to no session that owns no work. The `!activeId` exemption let
 * a session with nothing open create a work directory and fill it with artifacts, which is
 * how one came to exist with no `state.json` at all. `kiln open` writes that file through
 * the CLI, not through a guarded tool, so requiring it first costs nothing.
 */
function otherWorkDir(root, { target, activeId }) {
  const trees = [join(root, ".kiln", "work"), join(root, ".kiln", "tmp")];
  const tree = trees.find((dir) => isInside(dir, target));
  if (!tree) return null;
  if (!activeId) return "a work directory, and this session has no work open — run `kiln open` first";
  if (isInside(join(tree, activeId), target)) return null;
  // Two shapes, and calling the second one "another work's directory" was not true: a file
  // sitting directly in .kiln/tmp/ belongs to no work at all.
  const named = target.slice(tree.length + 1).split(sep).length > 1;
  return named ? "another work's directory" : `inside ${tree.slice(root.length + 1)} but not under any work id`;
}

/**
 * A project rule is one of the terms the run is judged by, which is what D48 is actually
 * about — not that config.json is hard to edit. Once a stage reads a rule, an agent that
 * finds one inconvenient could answer it by rewriting the rule, and `state.rules[]` would
 * still claim the run was handed the text that is no longer there.
 *
 * Only while a work is open. Outside a run nothing is being judged, and a person asking
 * their agent to help write a rule is doing exactly what the router is for.
 */
function ruleUnderJudgement(root, { target, activeId }) {
  if (!activeId || !isInside(join(kilnDir(root), "rules"), target)) return null;
  return "a project rule is one of the terms this run is judged by, so the run may not write it";
}

/**
 * What a removal verb may not reach. Deleting a file is a stronger edit than writing one,
 * which is why control files were the one exception D34 made for `rm`; a rule the run is
 * being judged by is the same argument, scoped to the run.
 */
export function isJudged(root, { target, activeId }) {
  return isControlFile(root, target) || ruleUnderJudgement(root, { target, activeId }) !== null;
}

/**
 * Deliberately ordered: control files first, because that answer does not depend on
 * whether kiln is driving; then the sandbox boundary; then cross-contamination.
 */
export function sandboxVerdict(root, { target, activeId }) {
  if (isControlFile(root, target)) {
    return { blocked: true, reason: "kiln writes its own control files; this one is not yours to edit" };
  }
  const judged = ruleUnderJudgement(root, { target, activeId });
  if (judged) return { blocked: true, reason: judged };
  if (!isInside(root, target) && !pathEquals(root, target)) {
    return { blocked: true, reason: "outside the project root" };
  }
  const foreign = otherWorkDir(root, { target, activeId });
  return foreign ? { blocked: true, reason: foreign } : { blocked: false };
}

/**
 * A block that names nowhere to go is the shape this project keeps meeting. The old text
 * named `.kiln/work/`, which holds the run's artifacts — not the place a temp file belongs,
 * and the agent reading it had just been refused the harness's own scratchpad for being
 * outside the project.
 */
export function sandboxMessage(root, { target, reason, activeId }) {
  const scratch = activeId ? `.kiln/tmp/${activeId}/` : ".kiln/tmp/<work-id>/";
  return `kiln blocked a write to ${target}: ${reason}.
The sandbox is ${root}, plus this work's own directory under .kiln/work/.
A temp file goes in ${scratch} — inside the project, gitignored, and removed at the end of SHIP.`;
}
