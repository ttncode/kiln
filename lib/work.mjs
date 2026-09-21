import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readState, statePath } from "./state.mjs";

function workRoot(root) {
  return join(root, ".kiln", "work");
}

/** Missing and corrupt are different findings: one is an unopened work, the other is D33's. */
function summarise(root, id) {
  if (!existsSync(statePath(root, id))) return { id, status: "unopened", stage: "-", pass: "-" };
  try {
    const state = readState(root, id);
    return { id, status: state.status, stage: state.stage, pass: state.pass };
  } catch {
    return { id, status: "unreadable", stage: "-", pass: "-" };
  }
}

/**
 * An unreadable state is listed rather than skipped: it is the shape guards block on,
 * so the user has to be able to see it here.
 */
export function listWork(root) {
  let ids = [];
  try {
    ids = readdirSync(workRoot(root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return ids.sort().map((id) => summarise(root, id));
}
