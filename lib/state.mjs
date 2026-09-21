import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonText } from "./config.mjs";

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

export function workDir(root, id) {
  return join(root, ".kiln", "work", id);
}

export function statePath(root, id) {
  return join(workDir(root, id), "state.json");
}

export function newWork({ id, sessionId, base, path = "bounded", dirtyAtOpen = [], auto = false }) {
  return {
    schema_version: SCHEMA_VERSION,
    id,
    status: STATUS.inProgress,
    session_id: sessionId,
    path,
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
export function adoptSession(state, sessionId) {
  if (state.session_id === sessionId) return state;
  const displaced = state.session_id ? [...(state.displaced ?? []), state.session_id] : (state.displaced ?? []);
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
