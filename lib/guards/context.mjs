import { readdirSync } from "node:fs";
import { join } from "node:path";
import { STATUS, readState, writeState } from "./../state.mjs";

export class GuardStateError extends Error {}

function workIds(root) {
  try {
    return readdirSync(join(root, ".kiln", "work"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Unreadable is not absent (D33). A work directory whose state cannot be parsed is the
 * case a fail-open guard would sail past, so it is raised rather than skipped.
 */
function loadAll(root) {
  return workIds(root).map((id) => {
    try {
      return readState(root, id);
    } catch {
      throw new GuardStateError(`.kiln/work/${id}/state.json cannot be read. kiln blocks until it can.`);
    }
  });
}

export function activeWorks(root) {
  return loadAll(root).filter((state) => state.status === STATUS.inProgress || state.status === STATUS.halted);
}

/**
 * A work opened without a session has no owner, and an unowned work is one
 * `workForSession` can never match — so `guard-gate` sees no active work and allows
 * every source edit. That is how the first real run shipped with its central guard
 * inert: nothing supplied `--session`, because nothing can. A session id exists only in
 * the hook payload, and this is the only place that payload is read.
 *
 * So the first guarded call in a session claims the work. Only when exactly one is
 * unbound: two would be a guess, and a guess about ownership is worse than none.
 */
export function claimUnbound(root, sessionId) {
  if (!sessionId) return null;
  const unbound = activeWorks(root).filter((state) => !state.session_id);
  if (unbound.length !== 1) return null;

  const bound = { ...unbound[0], session_id: sessionId };
  writeState(root, bound);
  return bound;
}

/**
 * Identity, not ownership: which work is this session driving, so guard-gate knows
 * whose gate record applies (D70). Ownership is a different question, below.
 */
export function workForSession(root, sessionId) {
  if (!sessionId) return null;
  return activeWorks(root).find((state) => state.session_id === sessionId) ?? null;
}

/**
 * "No work for this session" has two causes and they need opposite answers: kiln is not
 * driving this session (allow, proven), or this session was driving and was taken over
 * (block, because it does not know that yet).
 */
export function displacedFrom(root, sessionId) {
  if (!sessionId) return null;
  return activeWorks(root).find((state) => (state.displaced ?? []).includes(sessionId)) ?? null;
}

function claimedPaths(state) {
  return (state.predicted ?? []).map((row) => (typeof row === "string" ? row : row.path)).filter(Boolean);
}

/**
 * Ownership: is this path claimed by another active work? Disjoint claims run
 * concurrently; an overlapping one names the owner (D66).
 */
export function claimOwner(root, { path, excludeId }) {
  for (const state of activeWorks(root)) {
    if (state.id === excludeId) continue;
    if (claimedPaths(state).includes(path)) return state.id;
  }
  return null;
}

/**
 * D72: the refusal belongs where the claim is made. Two overlapping claims that meet at
 * write time block each other, which is a deadlock rather than a clear conflict.
 */
export function claimConflicts(root, { paths, forId }) {
  return paths
    .map((path) => ({ path, owner: claimOwner(root, { path, excludeId: forId }) }))
    .filter((row) => row.owner !== null);
}
