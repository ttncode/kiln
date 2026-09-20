import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readState } from "./state.mjs";

function workRoot(root) {
  return join(root, ".kiln", "work");
}

function summarise(root, id) {
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
