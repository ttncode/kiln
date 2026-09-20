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

/** People put the verdict first and the conditions after it. */
function openingClause(text) {
  return text.split(/[,;]|\s[—–]\s|\.\s|\n/)[0].trim();
}

/**
 * The verdict is read from the opening clause only.
 *
 * Scanning the whole answer read "yes, approved — cap stays 20, no new flag" as a
 * REJECTION, because `no` appeared in a condition attached to the approval. So did
 * "approved, no changes needed" and "lgtm, nothing to stop for". Four of five realistic
 * approvals were being flipped, and the tests missed it because every one of them fed a
 * single clean clause.
 *
 * An answer whose opening clause carries no verdict is not a yes. That is not a
 * limitation worked around: a gate wants a clear answer, and "sounds good, no changes"
 * has not given one.
 */
export function classifyAnswer(answer) {
  const text = (answer ?? "").trim();
  if (text === "") return DECISION.notAYes;

  const head = openingClause(text);
  if (matchesAny(APPROVED, head)) return DECISION.approved;
  if (matchesAny(REJECTED, head)) return DECISION.rejected;
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
