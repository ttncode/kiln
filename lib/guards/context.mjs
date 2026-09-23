import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { STATUS, adoptSession, isWorkId, readState, statePath, writeState } from "./../state.mjs";

export class GuardStateError extends Error {}

const ABSENT = new Set(["ENOENT", "ENOTDIR"]);

/**
 * Absent and unreadable are two answers (D33). Every read error here used to mean "no works",
 * so `chmod 000 .kiln/work/<id>` made a work kiln was driving disappear from the guard's view
 * and the next source edit went through ungated.
 */
function workIds(root) {
  try {
    return readdirSync(join(root, ".kiln", "work"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (ABSENT.has(error.code)) return [];
    throw new GuardStateError(`.kiln/work/ cannot be read (${error.code}). kiln blocks until it can.`);
  }
}

function hasState(root, id) {
  try {
    statSync(statePath(root, id));
    return true;
  } catch (error) {
    if (ABSENT.has(error.code)) return false;
    throw new GuardStateError(`.kiln/work/${id}/state.json cannot be read (${error.code}). kiln blocks until it can.`);
  }
}

/**
 * Unreadable is not absent (D33) — but **missing is not unreadable**, and conflating the
 * two bricked a real session.
 *
 * An agent wrote `brief.md` into a work directory before running `kiln open`, which is the
 * order kiln's own skill documented. The directory then existed with no `state.json`, every
 * read of it threw, the dispatcher turned the throw into a block, and *every* Bash call in
 * the session was refused — including the `kiln doctor` the error message told the user to
 * run. The only way out was deleting the directory from another terminal.
 *
 * The two cases are not the same risk. A **corrupt** state is the one D33 is about: it may
 * be a gate record someone damaged to get past a guard, so it still blocks. A **missing**
 * one carries no gate record at all, evades nothing, and means the directory is not a work
 * yet — `kiln doctor` names it and the session keeps running.
 */
function loadAll(root) {
  return workIds(root).flatMap((id) => {
    // A directory kiln could not have addressed is not a work, and a guard that throws on
    // one blocks every call in the session — the deadlock #63 closed, from another door.
    if (!isWorkId(id) || !hasState(root, id)) return [];
    try {
      return [readState(root, id)];
    } catch {
      throw new GuardStateError(`.kiln/work/${id}/state.json cannot be read. kiln blocks until it can.`);
    }
  });
}

/** The works that claim files: another work may not write what these predicted. */
export function activeWorks(root) {
  return loadAll(root).filter((state) => state.status === STATUS.inProgress || state.status === STATUS.halted);
}

/**
 * The works a session can still be driving, which is one more than the ones that claim.
 * A work that passed its review gate has released its claim — another work may touch those
 * files — but the run is not over: VERIFY and SHIP are still ahead, and a source edit in that
 * window was ungated because the work had left the set the guard looked in.
 */
const DRIVING = [STATUS.inProgress, STATUS.reviewed, STATUS.halted];

function drivingWorks(root) {
  return loadAll(root)
    .filter((state) => DRIVING.includes(state.status))
    .sort((a, b) => DRIVING.indexOf(a.status) - DRIVING.indexOf(b.status));
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
  const unbound = drivingWorks(root).filter((state) => !state.session_id);
  if (unbound.length !== 1) return null;

  const bound = adoptSession(unbound[0], sessionId);
  writeState(root, bound);
  return bound;
}

/**
 * Identity, not ownership: which work is this session driving, so guard-gate knows
 * whose gate record applies (D70). Ownership is a different question, below.
 *
 * A running work outranks a parked one. A halted work stays bound to its session, and the
 * refusal that stops a second `open` tells the agent to halt the first — so after doing
 * exactly that, which work the guard read depended on directory order.
 */
export function workForSession(root, sessionId) {
  if (!sessionId) return null;
  return drivingWorks(root).find((state) => state.session_id === sessionId) ?? null;
}

/**
 * "No work for this session" has two causes and they need opposite answers: kiln is not
 * driving this session (allow, proven), or this session was driving and was taken over
 * (block, because it does not know that yet).
 */
export function displacedFrom(root, sessionId) {
  if (!sessionId) return null;
  return drivingWorks(root).find((state) => (state.displaced ?? []).includes(sessionId)) ?? null;
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
