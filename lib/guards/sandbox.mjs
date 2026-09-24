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
  const records = join(root, ".kiln", "work");
  const scratch = join(root, ".kiln", "tmp");
  const tree = [records, scratch].find((dir) => isInside(dir, target));
  if (!tree) return null;
  // The two trees are not the same thing once a run ends. `work/` is the run's evidence and
  // stays kiln's; `tmp/` is scratch, and with nothing open it is the leftovers of something
  // finished. Refusing those with "run `kiln open` first" asks the agent to start a run in
  // order to tidy up after one — measured when a work reached `reviewed`, left `activeWorks`,
  // and could no longer delete the directory it had just been told to put its temp files in.
  if (!activeId) return tree === scratch ? null : "a work directory, and this session has no work open — run `kiln open` first";
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
 * A directory is as much a control file as the file inside it, for a verb that takes the
 * directory away. `rm -r .kiln/work/<id>` and `mv .kiln/work/<id> /tmp` remove the gate
 * record without naming it, and `rm -rf .kiln` removes all of them. cc-safety-net guards
 * its own policy file the same way: the file, its directory, or any ancestor.
 */
export function holdsControl(root, target) {
  const work = join(kilnDir(root), "work");
  const anchors = [join(kilnDir(root), "config.json"), work, join(kilnDir(root), "hooks"), join(root, ".git", "hooks"), join(kilnDir(root), "dna", "store")];
  if (anchors.some((anchor) => isInside(target, anchor))) return true;
  if (isDnaGuarded(root, target)) return true;
  return isInside(work, target) && target.slice(work.length + 1).split(sep).length === 1;
}

const DICTIONARY = /^domain-dictionary-[^/]*\.md$/;

/**
 * Everything under `.kiln/dna/` is kiln's to write except the project's domain dictionary
 * (D163), which sits directly in it. The siblings matter as much as the store: `store.previous`
 * is what a read recovers when the store is missing, so a file planted there is a store no gate
 * ever saw (D169).
 */
function isDnaGuarded(root, target) {
  const dna = join(kilnDir(root), "dna");
  if (!isInside(dna, target)) return false;
  const rest = target.slice(dna.length + 1);
  return !(rest && !rest.includes(sep) && DICTIONARY.test(rest));
}

/**
 * The DNA store is written by one command because every write has to pass the store's gates,
 * and a hand edit is the write that skips them. Not a safety line — `kiln dna check` finds a
 * store that was changed some other way — but the one place a refusal can name the right door.
 */
const DNA_STORE = "the DNA store is written only by `kiln dna apply <batch.json>`, which assigns the ids and runs the store's gates; write the batch as a temp file (below) and apply it";

/**
 * Deliberately ordered, and the order is the rule: kiln's own files first, because that
 * answer does not depend on whether kiln is driving; then the run's sandbox, which does.
 *
 * D33 says kiln does not police a session it is not driving. `sourceEditVerdict` honours
 * that — no state, no verdict — and this function never did: the project-root boundary
 * fired on `activeId` being absent just as hard as on its being present. Measured on a
 * user's own machine: one `kiln init`, no work open, and from then on **every** Claude
 * Code session in that project was refused a write to `~/.claude.json`, told the sandbox
 * was the project and offered `.kiln/tmp/<work-id>/` as the place to put it — a remedy
 * addressed to a work id that did not exist. A guard that fires when nothing is being
 * guarded is a false block, and D93 and D105 already record what false blocks buy.
 *
 * The boundary keeps its whole force where it is for something: while a run is open, an
 * agent kiln is driving stays inside the project. Outside a run there is no run to keep
 * anything inside of.
 */
export function sandboxVerdict(root, { target, activeId }) {
  if (isControlFile(root, target)) {
    return { blocked: true, reason: "kiln writes its own control files; this one is not yours to edit" };
  }
  if (isDnaGuarded(root, target)) return { blocked: true, reason: DNA_STORE };
  const judged = ruleUnderJudgement(root, { target, activeId });
  if (judged) return { blocked: true, reason: judged };
  if (activeId && !isInside(root, target) && !pathEquals(root, target)) {
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
A temp file goes in ${scratch} — inside the project, gitignored, and removed when \`kiln ship\` records the work shipped.`;
}
