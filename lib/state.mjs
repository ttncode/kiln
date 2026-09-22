import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonText } from "./config.mjs";
import { DEFAULT_TYPE } from "./ceremony.mjs";

export const SCHEMA_VERSION = 1;

export const STATUS = Object.freeze({
  inProgress: "in_progress",
  reviewed: "reviewed",
  shipped: "shipped",
  halted: "halted",
});

/** The five gate keys are fixed and total; only one of them unlocks source edits. */
export const GATE_KEYS = Object.freeze(["probe", "spec", "plan", "review", "ship"]);
export const AUTHORIZING = Object.freeze({ spike: "probe", bounded: "plan", full: "plan" });
export const SHIP_AUTHORIZING = Object.freeze({ spike: null, bounded: "review", full: "ship" });

export class StateError extends Error {}

/**
 * A work id becomes a directory name, so it is a path and was never checked as one.
 * Measured: `kiln open '../../../x'` wrote `state.json` **outside the project**, and
 * `../escaped` landed in `.kiln/` where `listWork` cannot see it — D7 item 5's own promise,
 * broken by kiln's own CLI rather than by anything a guard watches.
 *
 * Less dramatic and more likely: an agent minted `#1586` from a ticket, which is legal in a
 * filename and a comment character in a shell, so every command touching that work had to
 * remember to quote it. `mintId` would have produced `20260922-1586`; nothing made the id
 * kiln accepts the same as the id kiln mints.
 *
 * One segment, and only the characters a shell, a URL and a branch name all leave alone.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isWorkId(id) {
  return typeof id === "string" && SAFE_ID.test(id);
}

export function checkId(id) {
  if (typeof id !== "string" || id === "") throw new StateError("a work needs an id.");
  if (!isWorkId(id)) {
    throw new StateError(
      `"${id}" cannot be a work id: it has to be one path segment of letters, digits, dot, dash or underscore, starting with a letter or digit.\n` +
      "Let `kiln resolve <your argument>` mint one.",
    );
  }
  return id;
}

export function workDir(root, id) {
  return join(root, ".kiln", "work", checkId(id));
}

export function statePath(root, id) {
  return join(workDir(root, id), "state.json");
}

export function newWork({ id, sessionId, base, path = "bounded", dirtyAtOpen = [], auto = false, type = DEFAULT_TYPE }) {
  return {
    schema_version: SCHEMA_VERSION,
    id,
    status: STATUS.inProgress,
    session_id: sessionId,
    path,
    type,
    auto,
    stage: "INVESTIGATE",
    step: null,
    ...emptyLedger(base, dirtyAtOpen),
  };
}

/** The half of a new work that carries no decisions yet: what it claims, and where it started. */
function emptyLedger(base, dirtyAtOpen) {
  return {
    gates: {},
    predicted: [],
    base,
    last_verified: base,
    dirty_at_open: dirtyAtOpen,
    verify: [],
    pass: 1,
    carry_over: [],
    displaced: [],
  };
}


/**
 * A second session on one work takes it over out loud. The session it replaced is
 * remembered, because the alternative is what D66 was written to stop: the displaced
 * session keeps working and its guards are silently off — `workForSession` finds no
 * match for it, "no match" means kiln is not driving, and "not driving" means allow.
 */
/**
 * A session that owns the work is not displaced from it. Without the filter a work listed
 * its own owner: `open` with no `--session` wiped `session_id` and pushed the owner into
 * `displaced`, `claimUnbound` then re-claimed the unowned work, and the owner ended up in
 * both fields — twice over, on a real run.
 */
export function adoptSession(state, sessionId) {
  const previous = (state.displaced ?? []).filter((id) => id !== sessionId);
  // The early return used to skip the filter, so a record that already listed its owner as
  // displaced could never be repaired by the session that owned it — which is the only
  // session that would try.
  if (state.session_id === sessionId) return { ...state, displaced: previous };
  const displaced = state.session_id ? [...previous, state.session_id] : previous;
  return { ...state, session_id: sessionId, displaced };
}

export function readState(root, id) {
  return parseJsonText(readFileSync(statePath(root, id), "utf8"));
}

/** tmp + rename, so a crash mid-write cannot leave a half-file that guards must block on. */
export function writeState(root, state) {
  const dir = workDir(root, state.id);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, "state.json");
  const staging = `${target}.tmp`;
  writeFileSync(staging, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(staging, target);
  return target;
}

export function hashArtifact(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The agent supplies only `answer`; every other field is observed here, which is
 * the half of a gate record that cannot be forged from the conversation.
 */
export function recordGate(state, { key, decision, artifactPath, answer, by }) {
  if (!GATE_KEYS.includes(key)) throw new StateError(`unknown gate key: ${key}`);
  const record = {
    decision,
    artifact_sha: artifactPath ? hashArtifact(artifactPath) : null,
    answer,
    by: by ?? "user",
  };
  return { ...state, gates: { ...state.gates, [key]: record } };
}

export function recordVerify(state, entry) {
  return { ...state, verify: [...state.verify, entry] };
}

/**
 * A `fast` pass never advances the anchor, for the same reason it is never
 * reported as green: it ran only what the change touched.
 */
export function recordFullVerified(state, head) {
  return { ...state, last_verified: head };
}

/**
 * An approval belongs to the pass that earned it. Carrying `gates` across the
 * boundary would let a new pass edit source and open a PR on the strength of the
 * previous one — and the artifact hash cannot catch it, because an unchanged
 * document is exactly the case that slips through.
 */
export function openNextPass(state, shippedHead) {
  return {
    ...state,
    status: STATUS.inProgress,
    pass: state.pass + 1,
    gates: {},
    predicted: [],
    base: shippedHead,
    last_verified: shippedHead,
    verify: [],
    stage: "INVESTIGATE",
    step: null,
  };
}

export function gateApproved(state, key) {
  return state.gates?.[key]?.decision === "approved";
}

/** A recorded range that does not name the current HEAD describes an older tree. */
export function isStaleVerify(entry, currentRange) {
  return entry.range !== currentRange;
}
