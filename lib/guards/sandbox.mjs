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

function workPath(root, id) {
  return join(root, ".kiln", "work", id);
}

/**
 * `.kiln/work/` is kiln's own state area, so a path inside it belongs to whichever work
 * owns that directory — and to no session that owns no work. The `!activeId` exemption let
 * a session with nothing open create a work directory and fill it with artifacts, which is
 * how one came to exist with no `state.json` at all. `kiln open` writes that file through
 * the CLI, not through a guarded tool, so requiring it first costs nothing.
 */
function otherWorkDir(root, { target, activeId }) {
  const worksRoot = join(root, ".kiln", "work");
  if (!isInside(worksRoot, target)) return null;
  if (!activeId) return "a work directory, and this session has no work open — run `kiln open` first";
  return isInside(workPath(root, activeId), target) ? null : "another work's directory";
}

/**
 * Deliberately ordered: control files first, because that answer does not depend on
 * whether kiln is driving; then the sandbox boundary; then cross-contamination.
 */
export function sandboxVerdict(root, { target, activeId }) {
  if (isControlFile(root, target)) {
    return { blocked: true, reason: "kiln writes its own control files; this one is not yours to edit" };
  }
  if (!isInside(root, target) && !pathEquals(root, target)) {
    return { blocked: true, reason: "outside the project root" };
  }
  const foreign = otherWorkDir(root, { target, activeId });
  return foreign ? { blocked: true, reason: foreign } : { blocked: false };
}

export function sandboxMessage(root, { target, reason }) {
  return `kiln blocked a write to ${target}: ${reason}.
The sandbox is ${root}, plus this work's own directory under .kiln/work/.`;
}
