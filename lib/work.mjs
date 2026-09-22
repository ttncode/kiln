import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isWorkId, readState, statePath } from "./state.mjs";

function workRoot(root) {
  return join(root, ".kiln", "work");
}

/**
 * Enumerating what is on disk has to tolerate what it finds. Validating the id here threw
 * on a directory a previous version had happily created, and that killed `kiln list`,
 * `kiln doctor` and — through `activeWorks` — every guarded call in the session. Which is
 * the deadlock #63 fixed, reintroduced through a different door by the fix for #92.
 *
 * Only *addressing* a work checks its id. Finding one that cannot be addressed is a report.
 */
function summarise(root, id) {
  if (!isWorkId(id)) return { id, status: "invalid", stage: "-", pass: "-" };
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
