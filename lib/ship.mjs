import { actualChanged } from "./blast.mjs";
import { integrationBranch } from "./config.mjs";
import { moduleFor, modulesOf } from "./modules.mjs";
import { slugOfId } from "./resolve.mjs";

const ROOT_MODULE = ".";

/**
 * One unit of work can span several repositories, and each one needs its own pull request.
 * Gerrit solved this with a **topic**: a string shared by every change, submitted together
 * — the model Android runs across hundreds of repositories. kiln already mints exactly such
 * a string, so the work id is the topic and no new concept appears.
 *
 * Gerrit's own documentation states the two limits, and both are copied here rather than
 * papered over: a topic only triggers submission of the changes in it, so **submission can
 * fail partway and leave the topic half-merged**; and merge order is not derivable from the
 * repositories themselves. kiln reports both. Promising atomicity across a forge that has
 * no cross-project submit would be the kind of confident wrong statement this project exists
 * to refuse.
 */
/**
 * `kiln scope` subtracts what was already uncommitted when the run opened; this did not,
 * and the same diff then had two answers. On a real run it listed three repositories to
 * ship when the work touched one — the other two were the user's own dirty tree, recorded
 * in `dirty_at_open` before the work started.
 *
 * A file the plan claimed stays in, even if it was dirty at open: the run took
 * responsibility for it at the plan gate.
 */
function thisRunsFiles(root, state) {
  const preexisting = new Set(state.dirty_at_open ?? []);
  const claimed = new Set((state.predicted ?? []).map((row) => (typeof row === "string" ? row : row.path)));
  return actualChanged(root, state.base).filter((path) => !preexisting.has(path) || claimed.has(path));
}

export function shipPlan(root, { config, state }) {
  const files = thisRunsFiles(root, state);
  const byModule = new Map();
  for (const file of files) {
    const name = moduleFor(config, file) ?? ROOT_MODULE;
    byModule.set(name, [...(byModule.get(name) ?? []), file]);
  }

  const modules = [...byModule.entries()].map(([name, changed]) => ({
    name,
    path: name === ROOT_MODULE ? "." : modulesOf(config)[name],
    integration: integrationBranch(config, name === ROOT_MODULE ? undefined : name),
    files: changed,
  }));
  return { topic: state.id, branch: branchName(config, state), modules: modules.sort(sortByName) };
}

function sortByName(left, right) {
  return left.name.localeCompare(right.name);
}

/**
 * `branch_pattern` has been in the config since the first schema and nothing rendered it.
 * A placeholder the work cannot fill is named rather than left as the text `${type}` in a
 * branch name — the same law D60.1 applies to an unset `${cmd.x}`.
 *
 * `slug` used to be filled with the id, which is not a shorthand for it: the default
 * pattern `${id}-${slug}` then produced the id twice, ninety characters of branch name.
 * The slug is the descriptive tail of a minted id, and when there is none — a ticket ref
 * has no slug — it is reported unfillable rather than invented.
 */
export function branchName(config, state) {
  const values = { id: state.id, slug: slugOfId(state.id), type: state.type ?? null };
  const unfilled = [];
  const rendered = (config.vcs?.branch_pattern ?? "${id}").replace(/\$\{(\w+)\}/g, (match, key) => {
    if (values[key]) return values[key];
    unfilled.push(key);
    return match;
  });
  return unfilled.length === 0 ? rendered : { rendered, unfilled: [...new Set(unfilled)] };
}

const NOT_ATOMIC = [
  "",
  "Open one pull request per repository, each carrying the topic in its title.",
  "They do not merge atomically: nothing here can submit them together, a partial merge is possible,",
  "and the order is yours — kiln cannot derive which repository depends on which.",
];

/** `${id}` already ends with the slug, so a pattern asking for both says the same thing twice. */
function redundantLines(rendered, pattern) {
  if (!pattern.includes("${id}") || !pattern.includes("${slug}")) return [];
  return [`  vcs.branch_pattern asks for \${id} and \${slug}; the id already ends with the slug, so "${rendered}" repeats it.`];
}

function branchLines(branch, pattern) {
  const rendered = typeof branch === "string" ? branch : branch.rendered;
  const missing = typeof branch === "string" ? [] : branch.unfilled;
  return [
    `Use the same branch name in every one: ${rendered}`,
    ...(missing.length > 0 ? [`  vcs.branch_pattern still contains ${missing.map((key) => `\${${key}}`).join(", ")} — supply it or simplify the pattern.`] : []),
    ...redundantLines(rendered, pattern),
  ];
}

export function renderShipPlan(plan, pattern = "") {
  return [
    `Ship — ${plan.modules.length} repositor${plan.modules.length === 1 ? "y" : "ies"} · topic ${plan.topic}`,
    ...plan.modules.map((row) => `  ${row.path}  →  ${row.integration}   ${row.files.length} file(s)`),
    "",
    ...branchLines(plan.branch, pattern),
    ...(plan.modules.length > 1 ? NOT_ATOMIC : []),
  ].join("\n");
}
