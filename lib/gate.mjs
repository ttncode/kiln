/**
 * A gate that accepts "whatever you think" is a broken gate. These patterns are the
 * non-yeses D21 names: soft agreement that does not demonstrate the person read the
 * artifact. Anything unrecognised lands here too — a gate defaults to deny.
 */
const REJECTED = [
  /\bno\b/i,
  /\bdon'?t\b/i,
  /\bstop\b/i,
  /\breject/i,
  /\bnot yet\b/i,
];

/** Strong affirmatives only. "sounds good" is deliberately absent. */
const APPROVED = [
  /\byes\b/i,
  /\bapprove[ds]?\b/i,
  /\blgtm\b/i,
  /\bship it\b/i,
  /\bgo ahead\b/i,
  /\bproceed\b/i,
];

export const DECISION = Object.freeze({
  approved: "approved",
  rejected: "rejected",
  notAYes: "not_a_yes",
});

function matchesAny(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Rejection is checked first so "no, don't proceed" is not read as approval by the
 * word `proceed` sitting inside it.
 */
export function classifyAnswer(answer) {
  const text = (answer ?? "").trim();
  if (text === "") return DECISION.notAYes;
  if (matchesAny(REJECTED, text)) return DECISION.rejected;
  if (matchesAny(APPROVED, text)) return DECISION.approved;
  return DECISION.notAYes;
}

/**
 * The two concrete options a delegation has to be turned back into. A gate that
 * accepts "up to you" has recorded a decision nobody made.
 */
export function reAskFor(gateKey) {
  return {
    gate: gateKey,
    reason: "that is not an explicit yes",
    ask: `Pick one: (1) approve this ${gateKey} as written, or (2) tell me what to change.`,
  };
}
