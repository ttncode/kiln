/**
 * A gate that accepts "whatever you think" is a broken gate. These patterns are the
 * non-yeses D21 names: soft agreement that does not demonstrate the person read the
 * artifact. Anything unrecognised lands here too — a gate defaults to deny.
 */
const REJECTED = [
  /\bno\b/i,
  /\bnot\b/i,
  /\bnever\b/i,
  /\bcannot\b/i,
  /\b\w+n['’]t\b/i,
  /\b(?:dont|wont|cant|isnt|doesnt|didnt|shouldnt)\b/i,
  /\bstop\b/i,
  /\breject/i,
];

/** Strong affirmatives only. "sounds good" is deliberately absent. */
const APPROVED = [
  /\byes\b/i,
  /\bapprove[ds]?\b/i,
  /\baccept(?:s|ed)?\b/i,
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

/**
 * Where the earliest match of any pattern starts, or null. Order is the verdict: a negation
 * before the verb negates it ("I don't approve this", "Not approved"), and one after it is a
 * condition attached to a yes ("Approve -> no need to run the suite"). Reading the verb
 * wherever it appeared recorded "don't ship it" as an approval, which opens the gate D21
 * exists to keep shut.
 */
function firstMatch(patterns, text) {
  const starts = patterns.map((pattern) => text.search(pattern)).filter((at) => at >= 0);
  return starts.length === 0 ? null : Math.min(...starts);
}

/**
 * A menu prints its options with numbers, and a person answering one may send the label
 * back with its marker attached: `1. Approve this plan as written`. The marker is the
 * menu's, not theirs, and leaving it on split the clause at "1." and read no verdict at
 * all. Stripping it needs words after the marker, so a bare `1` still says nothing — which
 * is the part D21 is actually about.
 */
const LIST_MARKER = /^\s*(?:[([]?\d{1,2}[)\].:-]?|[-*•])\s+/;

/** People put the verdict first and the conditions after it. */
function openingClause(text) {
  return text.replace(LIST_MARKER, "").split(/[,;]|\s[—–]\s|\.\s|\n/)[0].trim();
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
  const approval = firstMatch(APPROVED, head);
  const refusal = firstMatch(REJECTED, head);
  if (refusal !== null && (approval === null || refusal < approval)) return DECISION.rejected;
  return approval === null ? DECISION.notAYes : DECISION.approved;
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
